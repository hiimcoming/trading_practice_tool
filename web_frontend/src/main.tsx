// 网页入口：挂载 Preact 应用。
import { render } from 'preact';
import { App } from './user_interface/app';
import './user_interface/app_styles.css';

render(<App />, document.getElementById('app')!);
