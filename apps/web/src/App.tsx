import { useEffect } from "react";
import { href, useRoute, type Route } from "./router.js";
import { PapersPage } from "./pages/PapersPage.js";
import { PaperPage } from "./pages/PaperPage.js";
import { TermPage } from "./pages/TermPage.js";
import { GlossaryPage } from "./pages/GlossaryPage.js";
import { SearchPage } from "./pages/SearchPage.js";
import { TranslatePage } from "./pages/TranslatePage.js";
import { SettingsPage } from "./pages/SettingsPage.js";

type NavKey = "search" | "translate" | "papers" | "glossary" | "settings";

const NAV: { key: NavKey; label: string; href: string }[] = [
  { key: "search", label: "探す", href: href.search() },
  { key: "translate", label: "翻訳", href: href.translate() },
  { key: "papers", label: "論文", href: href.papers() },
  { key: "glossary", label: "全体の用語 DB", href: href.glossary() },
  { key: "settings", label: "設定", href: href.settings() },
];

function navKey(route: Route): NavKey {
  if (route.page === "paper" || route.page === "term") return "papers";
  return route.page;
}

export function App() {
  const route = useRoute();
  const current = navKey(route);
  // ファイルをどこに落としても、ブラウザがそのファイルを開いて画面を離れないようにする（受け付けるのは翻訳の画面だけ）。契約付録 §9
  useEffect(() => {
    const block = (e: DragEvent): void => {
      const onFileInput = e.target instanceof HTMLInputElement && e.target.type === "file";
      if (e.dataTransfer?.types.includes("Files") === true && !onFileInput) e.preventDefault();
    };
    window.addEventListener("dragover", block);
    window.addEventListener("drop", block);
    return () => {
      window.removeEventListener("dragover", block);
      window.removeEventListener("drop", block);
    };
  }, []);
  return (
    <>
      <header className="site-header">
        <div className="container header-inner">
          <a className="brand" href={href.papers()}>
            JPaper
          </a>
          <nav className="nav">
            {NAV.map((n) => (
              <a key={n.key} className={current === n.key ? "active" : ""} href={n.href}>
                {n.label}
              </a>
            ))}
          </nav>
        </div>
      </header>
      <main className="container page">
        {route.page === "papers" && <PapersPage />}
        {route.page === "paper" && <PaperPage key={route.id} id={route.id} />}
        {route.page === "term" && (
          <TermPage key={`${route.id}/${route.src}`} id={route.id} src={route.src} initialJa={route.ja} />
        )}
        {route.page === "glossary" && <GlossaryPage />}
        {route.page === "search" && <SearchPage key={route.q ?? ""} q={route.q} />}
        {route.page === "translate" && <TranslatePage id={route.id} title={route.title} />}
        {route.page === "settings" && <SettingsPage />}
      </main>
    </>
  );
}
