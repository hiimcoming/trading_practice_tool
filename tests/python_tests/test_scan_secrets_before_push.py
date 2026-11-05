# -*- coding: utf-8 -*-
"""
推送前敏感字眼扫描（scripts/scan_secrets_before_push.py）的测试。
每个测试在临时目录建一个独立的 git 仓库（不碰本项目的仓库），把脚本复制进去，用一份测试专用词表运行。
本文件自己也会被推送前扫描检查，所以测试用的「个人 IP / 邮箱 / 私钥头」都用拼接方式写出，文件里不出现完整原文。
"""
import os
import shutil
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "scan_secrets_before_push.py"
NOREPLY = "1+tester@users.noreply.github.com"
PERSONAL_IP = ".".join(["203", "0", "113", "7"])          # 文档专用示例地址段，当作「个人服务器 IP」
ALLOWED_IP = ".".join(["198", "51", "100", "9"])          # 写进词表 [allow] 段的地址
PERSONAL_EMAIL = "someone" + "@" + "mail-provider.test"
WORDS = f"[block]\nzebra\n/home/someone/private\n\n[allow]\n{ALLOWED_IP}\n"


def run(cmd, r, stdin=None):
    return subprocess.run(cmd, cwd=r.root, env=r.env, input=stdin, capture_output=True, text=True, encoding="utf-8")


def git(r, *args):
    res = run(["git", *args], r)
    assert res.returncode == 0, res.stderr
    return res.stdout


def scan(r, *args):
    return run([sys.executable, "scripts/scan_secrets_before_push.py", *args], r)


def write(r, files):
    for name, text in files.items():
        (r.root / name).write_text(text, encoding="utf-8")


def commit(r, files, message="改动", author_email=None):
    write(r, files)
    git(r, "add", "-A")
    if author_email:
        r.env.update(GIT_AUTHOR_EMAIL=author_email)
    git(r, "commit", "-q", "-m", message)
    r.env.pop("GIT_AUTHOR_EMAIL", None)


@pytest.fixture
def repo(tmp_path):
    root = tmp_path / "repo"
    root.mkdir()
    words = tmp_path / "words.txt"
    words.write_text(WORDS, encoding="utf-8")
    env = {**os.environ, "TPT_SENSITIVE_WORDS_FILE": str(words), "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}
    r = SimpleNamespace(root=root, env=env, tmp=tmp_path)
    git(r, "init", "-q", "-b", "main")
    git(r, "config", "user.name", "tester")
    git(r, "config", "user.email", NOREPLY)
    (root / "scripts").mkdir()
    shutil.copy(SCRIPT, root / "scripts" / SCRIPT.name)
    (root / ".venv" / "bin").mkdir(parents=True)
    (root / ".venv" / "bin" / "python").symlink_to(sys.executable)  # 钩子优先用项目里的 .venv/bin/python
    write(r, {".gitignore": ".venv/\n*.db\n"})
    return r


def test_clean_files_pass(repo):
    write(repo, {"app.py": "print('hello')\nHOST = '127.0.0.1'\n"})
    res = scan(repo)
    assert res.returncode == 0, res.stdout
    assert "通过，0 处" in res.stdout


def test_block_word_reports_file_and_line(repo):
    write(repo, {"app.py": "x = 1\nname = 'Zebra_01'\n"})
    res = scan(repo)
    assert res.returncode == 1
    assert "app.py:2" in res.stdout and "zebra" in res.stdout


def test_whole_word_does_not_hit_longer_words(repo):
    write(repo, {"app.py": "zebras = 1\nazebra = 2\n"})
    assert scan(repo).returncode == 0


def test_word_with_symbols_matches_anywhere(repo):
    write(repo, {"cfg.py": "DATA = '/HOME/someone/private/data'\n"})
    res = scan(repo)
    assert res.returncode == 1 and "cfg.py:1" in res.stdout


def test_unknown_ip_blocked_but_local_and_allowed_pass(repo):
    write(repo, {"net.py": f"A = '127.0.0.1'\nB = '{ALLOWED_IP}'\nC = '{PERSONAL_IP}'\nD = 'server {PERSONAL_IP}.'\n"})
    res = scan(repo)
    assert res.returncode == 1
    assert "net.py:3" in res.stdout and "net.py:4" in res.stdout  # 句末带句号的也能抓到
    assert "net.py:1" not in res.stdout and "net.py:2" not in res.stdout


def test_personal_email_blocked_noreply_passes(repo):
    write(repo, {"notes.md": f"contact {PERSONAL_EMAIL}\nbot {NOREPLY}\n"})
    res = scan(repo)
    assert res.returncode == 1
    assert "notes.md:1" in res.stdout and "notes.md:2" not in res.stdout


def test_private_key_header_blocked(repo):
    write(repo, {"notes.txt": "-----BEGIN " + "OPENSSH PRIVATE KEY-----\n"})
    res = scan(repo)
    assert res.returncode == 1 and "私钥文件内容" in res.stdout


def test_force_added_ignored_file_blocked(repo):
    (repo.root / "users.db").write_bytes(b"SQLite format 3\0")
    git(repo, "add", "-f", "users.db")
    git(repo, "commit", "-q", "-m", "强行加入数据库")
    res = scan(repo)
    assert res.returncode == 1
    assert "命中 .gitignore" in res.stdout and "users.db" in res.stdout


def test_commit_with_personal_author_email_blocked(repo):
    commit(repo, {"a.py": "x = 1\n"}, author_email=PERSONAL_EMAIL)
    res = scan(repo)
    assert res.returncode == 1 and "作者邮箱不是 GitHub 隐藏邮箱" in res.stdout


def test_next_commit_identity_checked(repo):
    git(repo, "config", "user.email", PERSONAL_EMAIL)
    res = scan(repo)
    assert res.returncode == 1 and "下一次提交的邮箱" in res.stdout


def test_large_file_blocked(repo):
    (repo.root / "big.bin").write_bytes(b"\0" * (10 * 1024 * 1024 + 1))
    res = scan(repo)
    assert res.returncode == 1 and "超过 10 MB" in res.stdout


def test_missing_words_file_warns_but_general_rules_still_work(repo):
    repo.env["TPT_SENSITIVE_WORDS_FILE"] = str(repo.tmp / "not_here.txt")
    write(repo, {"a.py": f"HOST = '{PERSONAL_IP}'\n"})
    res = scan(repo)
    assert "未找到个人词表" in res.stdout
    assert res.returncode == 1 and "a.py:1" in res.stdout


def test_pre_push_hook_blocks_and_history_counts(repo):
    remote = repo.tmp / "remote.git"
    subprocess.run(["git", "init", "-q", "--bare", str(remote)], env=repo.env, check=True)
    git(repo, "remote", "add", "origin", str(remote))
    assert scan(repo, "--install-hook").returncode == 0
    commit(repo, {"a.py": "x = 1\n"}, "第一次")
    assert run(["git", "push", "-q", "origin", "main"], repo).returncode == 0
    commit(repo, {"b.py": "name = 'Zebra'\n"}, "带敏感词")
    blocked = run(["git", "push", "-q", "origin", "main"], repo)
    assert blocked.returncode != 0 and "b.py:1" in blocked.stderr + blocked.stdout
    commit(repo, {"b.py": "name = 'x'\n"}, "删掉敏感词")  # 后面再删没用：历史里还在，照样拦
    again = run(["git", "push", "-q", "origin", "main"], repo)
    assert again.returncode != 0 and "b.py:1" in again.stderr + again.stdout
    git(repo, "reset", "-q", "--hard", "HEAD~2")  # 改写历史：去掉那两个提交
    commit(repo, {"b.py": "name = 'x'\n"}, "干净的版本")
    assert run(["git", "push", "-q", "origin", "main"], repo).returncode == 0
    pushed = subprocess.run(["git", "--git-dir", str(remote), "log", "--all", "-p"], capture_output=True, text=True).stdout
    assert "Zebra" not in pushed


def test_install_hook_keeps_foreign_hook(repo):
    hook = repo.root / ".git" / "hooks" / "pre-push"
    hook.write_text("#!/bin/sh\necho other\n", encoding="utf-8")
    assert scan(repo, "--install-hook").returncode == 2
    assert hook.read_text(encoding="utf-8") == "#!/bin/sh\necho other\n"
