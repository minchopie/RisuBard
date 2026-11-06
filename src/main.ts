import "./ts/polyfill";
import "katex/dist/katex.min.css";
import "./styles.css";
import "./styles/nodeonly-standard.css";
import "core-js/actual"
import "./ts/log-capture"
import "./ts/storage/database.svelte"
import App from "./App.svelte";
import { loadData } from "./ts/bootstrap";
import { initHotkey } from "./ts/hotkey";
import { preLoadCheck } from "./preload";
import { mount, tick } from "svelte";
import { applyEarlyLanguage } from "./lang";

window.addEventListener('vite:preloadError', (event) => {
    console.error("Chunk load error detected:", event);
    alert("The server has been updated or the network connection has been lost. Please refresh the page.");
});

preLoadCheck()
applyEarlyLanguage()
let app = mount(App, {
    target: document.getElementById("app"),
});

async function handoffStartupLogo() {
    const preloader = document.getElementById('preloading')
    const appLogo = document.querySelector<HTMLImageElement>('[data-startup-logo="app"]')
    if (appLogo) {
        try { await appLogo.decode() } catch {}
    }
    preloader?.remove()
}

export const ready = (async () => {
    await tick()
    await handoffStartupLogo()
    await loadData()
    initHotkey()
})()

export default app;
