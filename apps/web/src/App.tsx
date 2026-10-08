import { href, useRoute } from "./router.js";
import { PapersPage } from "./pages/PapersPage.js";
import { PaperPage } from "./pages/PaperPage.js";
import { TermPage } from "./pages/TermPage.js";
import { GlossaryPage } from "./pages/GlossaryPage.js";

export function App() {
  const route = useRoute();
  const onGlossary = route.page === "glossary";
  return (
    <>
      <header className="site-header">
        <div className="container header-inner">
          <a className="brand" href={href.papers()}>
            JPaper 用語集
          </a>
          <nav className="nav">
            <a className={onGlossary ? "" : "active"} href={href.papers()}>
              論文
            </a>
            <a className={onGlossary ? "active" : ""} href={href.glossary()}>
              全体の用語 DB
            </a>
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
      </main>
    </>
  );
}
