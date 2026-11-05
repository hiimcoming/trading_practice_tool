# -*- coding: utf-8 -*-
"""
推送前敏感字眼扫描（规格书 16.1 节、D87）：防止个人信息和密钥被推送到公开的 GitHub 仓库。

查什么（任何一条命中就拦下，并列出「文件:行号 + 原因」）：
  1. 个人词表里的词：代理服务字眼、个人邮箱、本机路径、名字、服务器 IP 等。
     词表默认在 ai_guide/sensitive_words.txt（不上传 GitHub），可用环境变量 TPT_SENSITIVE_WORDS_FILE 换位置。
     本脚本自己不写任何具体的个人词语，所以它本身可以公开。
  2. 通用规则：形似 IP 地址、邮箱地址的文字（放行名单里的除外）；私钥文件头；几种常见平台的密钥格式。
  3. 文件：命中 .gitignore 的文件（说明是被强行加进去的，例如用户数据库、内部文档）；超过 10 MB 的大文件。
  4. 提交本身：提交说明的文字；作者和提交人的邮箱必须是 GitHub 隐藏邮箱（…@users.noreply.github.com）。

用法（在项目根目录运行）：
  .venv/bin/python scripts/scan_secrets_before_push.py                 预演：扫描「现在提交会带上的文件」和还没推送的提交
  .venv/bin/python scripts/scan_secrets_before_push.py --install-hook  安装「推送前自动检查」（git 的 pre-push 钩子，
                                                                       存在本机 .git/hooks 里，不上传；之后每次推送自动运行）
  --pre-push 由钩子自动调用，不需要手动用。

推送时只扫「这次要上传、远端还没有的提交」：每个提交新增的每一行、文件、提交说明、作者邮箱。
注意：敏感内容一旦进了某个提交，后面再删也没用（历史里还在），会一直拦下，需要改写那个提交。
误报怎么办：把误报的那段文字写进词表的 [allow] 段（只对 IP、邮箱这两条通用规则生效）。
只用标准库，不需要安装任何依赖。
"""
from __future__ import annotations

import argparse
import os
import re
import stat
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

WORDS_FILE_ENV = "TPT_SENSITIVE_WORDS_FILE"
DEFAULT_WORDS_FILE = Path("ai_guide") / "sensitive_words.txt"  # 相对项目根目录
MAX_FILE_BYTES = 10 * 1024 * 1024
NOREPLY_SUFFIX = "@users.noreply.github.com"
ZERO_SHA = "0" * 40
MAX_PRINTED_HITS = 200
HOOK_MARKER = "scan_secrets_before_push.py --pre-push"

# 通用放行：本机地址、全零地址；画线库图标的 SVG 路径数据里两串形似 IP 的数字（web_frontend/vendor/）；
# 公共的「不回信」地址和 git 协议地址。
BUILTIN_ALLOW = {
    "127.0.0.1", "0.0.0.0", "1.8.35.35", "1.15.36.35",
    "noreply@github.com", "noreply@anthropic.com", "git@github.com",
}
ALLOWED_EMAIL_DOMAINS = ("example.com", "example.org", "example.net")

IP_RE = re.compile(r"(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?!\.?\d)")
EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}")
SECRET_PATTERNS = [
    ("私钥文件内容", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("GitHub 令牌", re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{50,}")),
    ("AWS 密钥", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("AI 平台密钥", re.compile(r"\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}")),
]
HUNK_RE = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@")


@dataclass
class WordList:
    """个人词表：block 是要拦的词（原词 + 匹配规则），allow 是通用规则的放行名单（小写）。"""
    block: list = field(default_factory=list)
    allow: set = field(default_factory=set)
    found: bool = False


@dataclass
class Hit:
    """一处命中：在哪（文件:行号 或 提交）、为什么、命中的文字。"""
    where: str
    reason: str
    text: str


# ---------------------------------------------------------------- git 与词表

def git(repo: Path, args: list, input_text: str | None = None, ok_codes: tuple = (0,)) -> str:
    """运行一条 git 命令并返回输出；返回码不在 ok_codes 里就报错（由调用方拦下推送）。"""
    result = subprocess.run(
        ["git", "-c", "core.quotepath=false", *args], cwd=repo, input=input_text,
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if result.returncode not in ok_codes:
        raise RuntimeError(f"git {' '.join(args[:3])} 失败：{result.stderr.strip()}")
    return result.stdout


def repo_root() -> Path:
    """当前所在的 git 仓库根目录。"""
    return Path(git(Path.cwd(), ["rev-parse", "--show-toplevel"]).strip())


def word_pattern(word: str) -> re.Pattern:
    """纯字母数字的词按「整词」匹配（tom 能拦 Tom_01，不拦 atom）；其余按原样包含匹配。都不分大小写。"""
    if re.fullmatch(r"[A-Za-z0-9]+", word):
        return re.compile(r"(?<![A-Za-z])" + re.escape(word) + r"(?![A-Za-z])", re.IGNORECASE)
    return re.compile(re.escape(word), re.IGNORECASE)


def load_words(root: Path) -> tuple:
    """读个人词表，返回 (WordList, 词表路径)。文件格式：[block] / [allow] 两段，一行一个，# 开头是注释。"""
    path = Path(os.environ.get(WORDS_FILE_ENV) or (root / DEFAULT_WORDS_FILE))
    words = WordList()
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return words, path
    words.found = True
    section = "block"
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.lower() in ("[block]", "[allow]"):
            section = line.lower()[1:-1]
        elif section == "block":
            words.block.append((line, word_pattern(line)))
        else:
            words.allow.add(line.lower())
    return words, path


# ---------------------------------------------------------------- 逐行检查

def is_allowed(text: str, words: WordList) -> bool:
    """IP、邮箱这两条通用规则的放行判断。"""
    low = text.lower()
    if low in BUILTIN_ALLOW or low in words.allow or low.endswith(NOREPLY_SUFFIX):
        return True
    return any(low.endswith("@" + d) for d in ALLOWED_EMAIL_DOMAINS)


def scan_line(line: str, where: str, words: WordList) -> list:
    """检查一行文字，返回这一行的所有命中。"""
    hits = [Hit(where, "个人词表", w) for w, pat in words.block if pat.search(line)]
    for m in IP_RE.finditer(line):
        ip = m.group(0)
        if all(int(p) <= 255 for p in ip.split(".")) and not is_allowed(ip, words):
            hits.append(Hit(where, "形似 IP 地址", ip))
    for m in EMAIL_RE.finditer(line):
        if not is_allowed(m.group(0), words):
            hits.append(Hit(where, "邮箱地址", m.group(0)))
    for reason, pat in SECRET_PATTERNS:
        m = pat.search(line)
        if m:
            hits.append(Hit(where, reason, m.group(0)[:12] + "…"))
    return hits


def scan_text(text: str, where_prefix: str, words: WordList) -> list:
    """逐行检查一整段文字（文件内容或提交说明），位置写成「前缀:行号」。"""
    hits = []
    for n, line in enumerate(text.splitlines(), start=1):
        hits.extend(scan_line(line, f"{where_prefix}:{n}", words))
    return hits


def ignored_paths(root: Path, paths: list) -> list:
    """这些路径里哪些命中 .gitignore（不管是否已被 git 跟踪），用 git 自己的规则判断，不另写一份。"""
    if not paths:
        return []
    out = git(root, ["check-ignore", "--no-index", "--stdin", "-z"], "\0".join(paths) + "\0", ok_codes=(0, 1))
    return [p for p in out.split("\0") if p]


def path_hits(root: Path, paths: list, sizes: dict) -> list:
    """文件层面的检查：被 .gitignore 挡住却在提交里的文件、超过大小上限的文件。"""
    hits = [Hit(p, "命中 .gitignore 的文件（被强行加入）", p) for p in ignored_paths(root, paths)]
    for p, size in sizes.items():
        if size > MAX_FILE_BYTES:
            hits.append(Hit(p, f"文件超过 {MAX_FILE_BYTES // 1024 // 1024} MB", f"{size / 1024 / 1024:.1f} MB"))
    return hits


# ---------------------------------------------------------------- 扫描提交

def diff_args(root: Path, sha: str) -> list:
    """一个提交相对它第一个父提交的改动；第一个提交（没有父提交）就是全部内容。"""
    parents = git(root, ["rev-list", "--parents", "-n", "1", sha]).split()[1:]
    return [parents[0], sha] if parents else ["--root", "--no-commit-id", sha]


def commit_files(root: Path, sha: str) -> dict:
    """这个提交新增或修改的文件 → 文件大小（删除的文件不算）。"""
    out = git(root, ["diff-tree", "-r", "--raw", "-z", "--no-renames", *diff_args(root, sha)])
    items = [x for x in out.split("\0") if x]
    blobs = {}
    for meta, path in zip(items[0::2], items[1::2]):
        fields = meta.split()
        if fields[-1] != "D":
            blobs[path] = fields[3]
    sizes = {}
    if blobs:
        info = git(root, ["cat-file", "--batch-check"], "\n".join(blobs.values()) + "\n").splitlines()
        by_sha = {line.split()[0]: int(line.split()[2]) for line in info if len(line.split()) == 3}
        sizes = {p: by_sha.get(s, 0) for p, s in blobs.items()}
    return sizes


def added_lines_hits(root: Path, sha: str, words: WordList) -> list:
    """检查这个提交新增的每一行（位置写成 文件:新文件里的行号）。"""
    patch = git(root, ["diff-tree", "-p", "-r", "--unified=0", "--no-color", "--no-ext-diff",
                       "--no-renames", *diff_args(root, sha)])
    hits, path, line_no, in_header = [], None, 0, False
    for line in patch.splitlines():
        if line.startswith("diff --git "):
            in_header, path = True, None
        elif in_header and line.startswith("+++ "):
            target = line[4:].rstrip("\t").strip('"')  # 文件名含空格时 git 会在末尾加制表符，含特殊字符时加引号
            path = target[2:] if target.startswith("b/") else None
        elif line.startswith("@@"):
            in_header = False
            m = HUNK_RE.match(line)
            line_no = int(m.group(1)) if m else 0
        elif not in_header and line.startswith("+") and path:
            hits.extend(scan_line(line[1:], f"{path}:{line_no}", words))
            line_no += 1
    return hits


def scan_commit(root: Path, sha: str, words: WordList) -> list:
    """一个提交的全部检查：作者邮箱、提交说明、文件、新增的每一行。"""
    short = sha[:7]
    hits = []
    who = git(root, ["log", "-1", "--format=%ae%n%ce", sha]).split()
    for role, email in zip(("作者", "提交人"), who):
        if not email.lower().endswith(NOREPLY_SUFFIX) and email.lower() not in BUILTIN_ALLOW:
            hits.append(Hit(f"提交 {short}", f"{role}邮箱不是 GitHub 隐藏邮箱", email))
    message = git(root, ["log", "-1", "--format=%B", sha])
    hits.extend(scan_text(message, f"提交 {short} 的说明", words))
    sizes = commit_files(root, sha)
    hits.extend(path_hits(root, list(sizes), sizes))
    hits.extend(added_lines_hits(root, sha, words))
    return hits


def commits_to_push(root: Path, stdin_text: str, remote: str) -> list:
    """按 git 交给钩子的推送清单，找出远端还没有的提交（从旧到新，去重）。"""
    shas = []
    for line in stdin_text.splitlines():
        parts = line.split()
        if len(parts) != 4 or parts[1] == ZERO_SHA:  # 格式不对，或是删除远端分支（不上传内容）
            continue
        local_sha, remote_sha = parts[1], parts[3]
        if remote_sha != ZERO_SHA and object_exists(root, remote_sha):
            rng = [f"{remote_sha}..{local_sha}"]
        else:
            rng = [local_sha, "--not", f"--remotes={remote}"]
        for sha in git(root, ["rev-list", "--reverse", *rng]).split():
            if sha not in shas:
                shas.append(sha)
    return shas


def object_exists(root: Path, sha: str) -> bool:
    """本地有没有这个提交（远端被别处改写过时可能没有）。"""
    return subprocess.run(["git", "cat-file", "-e", sha], cwd=root, capture_output=True).returncode == 0


def unpushed_commits(root: Path) -> list:
    """预演用：本地还没推送到任何远端的提交；一个提交都没有时返回空。"""
    if subprocess.run(["git", "rev-parse", "--verify", "-q", "HEAD"], cwd=root, capture_output=True).returncode != 0:
        return []
    return git(root, ["rev-list", "--reverse", "HEAD", "--not", "--remotes"]).split()


# ---------------------------------------------------------------- 扫描工作区（预演）

def worktree_hits(root: Path, words: WordList) -> tuple:
    """预演：扫描「现在提交会带上的文件」（已跟踪 + 未被忽略的新文件），返回 (命中, 文件数)。"""
    listed = git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split("\0")
    files = [p for p in dict.fromkeys(listed) if p and (root / p).is_file()]
    sizes = {p: (root / p).stat().st_size for p in files}
    hits = path_hits(root, files, sizes)
    for p in files:
        try:
            data = (root / p).read_bytes()
        except OSError as exc:
            hits.append(Hit(p, "读取失败", str(exc)))
            continue
        if b"\0" not in data[:8000]:  # 二进制文件（图片等）不按文字检查
            hits.extend(scan_text(data.decode("utf-8", errors="replace"), p, words))
    return hits, len(files)


def identity_hits(root: Path) -> list:
    """预演：下一次提交会用的作者邮箱是不是 GitHub 隐藏邮箱。"""
    hits = []
    for var in ("GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"):
        ident = git(root, ["var", var], ok_codes=(0, 128))
        m = re.search(r"<([^>]*)>", ident)
        if m and not m.group(1).lower().endswith(NOREPLY_SUFFIX):
            hits.append(Hit("本项目 git 设置", "下一次提交的邮箱不是 GitHub 隐藏邮箱", m.group(1)))
    return hits


# ---------------------------------------------------------------- 钩子与输出

def hook_path(root: Path) -> Path:
    """本仓库的 pre-push 钩子文件位置（尊重 core.hooksPath 设置）。"""
    return root / git(root, ["rev-parse", "--git-path", "hooks"]).strip() / "pre-push"


def install_hook(root: Path) -> int:
    """写入 pre-push 钩子：每次 git push 前自动运行本脚本，命中就拦下。已有别的钩子时不覆盖。"""
    path = hook_path(root)
    if path.exists() and HOOK_MARKER not in path.read_text(encoding="utf-8", errors="replace"):
        print(f"[扫描] {path} 已有别的推送前钩子，未覆盖；请手动合并。")
        return 2
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "#!/bin/sh\n"
        "# 由 scripts/scan_secrets_before_push.py --install-hook 生成：推送前自动扫描敏感字眼（只在本机，不上传）\n"
        'PY=".venv/bin/python"\n[ -x "$PY" ] || PY="python3"\n'
        f'exec "$PY" scripts/{HOOK_MARKER} "$@"\n',
        encoding="utf-8",
    )
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    print(f"[扫描] 已安装推送前自动检查：{path}")
    return 0


def report(hits: list, blocked_message: str) -> int:
    """打印结果：没有命中返回 0；有命中逐条列出并返回 1（推送时返回 1 = 拦下）。"""
    if not hits:
        print("[扫描] 结果：通过，0 处。")
        return 0
    print(f"[扫描] 结果：发现 {len(hits)} 处。{blocked_message}")
    for h in hits[:MAX_PRINTED_HITS]:
        print(f"  [{h.reason}] {h.where}  →  {h.text}")
    if len(hits) > MAX_PRINTED_HITS:
        print(f"  …其余 {len(hits) - MAX_PRINTED_HITS} 处未列出")
    return 1


def print_words_status(words: WordList, path: Path) -> None:
    """说明这次用的词表（找不到时提醒：只剩通用规则）。"""
    if words.found:
        print(f"[扫描] 个人词表：{path.name}（拦 {len(words.block)} 个词，放行 {len(words.allow)} 条）")
    else:
        print(f"[扫描] 警告：未找到个人词表 {path}，这次只用通用规则（IP、邮箱、密钥格式、.gitignore）。")


def run_pre_push(root: Path, remote: str, words: WordList) -> int:
    """钩子模式：扫描这次要推送的全部提交。"""
    shas = commits_to_push(root, sys.stdin.read(), remote)
    print(f"[扫描] 推送前检查：{len(shas)} 个远端还没有的提交")
    hits = []
    for sha in shas:
        hits.extend(scan_commit(root, sha, words))
    return report(hits, "推送已拦下，什么都没有上传。改好后找 Claude 改写有问题的提交，再重新推送。")


def run_preview(root: Path, words: WordList) -> int:
    """预演模式：现在提交会带上的文件 + 还没推送的提交 + 下一次提交用的邮箱。"""
    hits, n_files = worktree_hits(root, words)
    shas = unpushed_commits(root)
    print(f"[扫描] 预演：{n_files} 个将要提交的文件，{len(shas)} 个还没推送的提交")
    for sha in shas:
        hits.extend(scan_commit(root, sha, words))
    hits.extend(identity_hits(root))
    hook = "已安装" if hook_path(root).exists() else "未安装（运行 --install-hook 安装）"
    print(f"[扫描] 推送前自动检查：{hook}")
    return report(hits, "这些内容如果提交并推送，就会公开。")


def main(argv: list | None = None) -> int:
    parser = argparse.ArgumentParser(description="推送前敏感字眼扫描")
    parser.add_argument("--install-hook", action="store_true", help="安装推送前自动检查")
    parser.add_argument("--pre-push", nargs="*", metavar="远端", help="由 git 钩子调用")
    args = parser.parse_args(argv)
    try:
        root = repo_root()
        if args.install_hook:
            return install_hook(root)
        words, path = load_words(root)
        print_words_status(words, path)
        if args.pre_push is not None:
            return run_pre_push(root, args.pre_push[0] if args.pre_push else "origin", words)
        return run_preview(root, words)
    except Exception as exc:  # 任何意外都按「不通过」处理，宁可拦错也不放过
        print(f"[扫描] 出错，为安全起见按不通过处理：{exc}")
        return 2


if __name__ == "__main__":
    sys.exit(main())
