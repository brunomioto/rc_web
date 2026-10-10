import './ui/styles.css';
import { startApp } from './ui/app';

const root = document.getElementById('app')!;
startApp(root).catch((e) => {
  console.error(e);
  root.prepend(Object.assign(document.createElement('pre'), { className: 'fatal', textContent: `Could not start: ${e?.message ?? e}` }));
});
