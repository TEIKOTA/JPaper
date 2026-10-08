// 契約付録 §9（Web アプリ）。ハッシュによる画面の切り替え。
import { useEffect, useState } from "react";

export type Route =
  | { page: "papers" }
  | { page: "paper"; id: string }
  | { page: "term"; id: string; src: string; ja?: string }
  | { page: "glossary" };

export function parseRoute(hash: string): Route {
  const [pathPart = "", query = ""] = hash.replace(/^#/, "").split("?");
  const parts = pathPart.split("/").filter((p) => p !== "").map((p) => decodeURIComponent(p));
  const params = new URLSearchParams(query);
  if (parts[0] === "glossary") return { page: "glossary" };
  if (parts[0] === "papers" && parts[1] !== undefined) {
    if (parts[2] === "terms" && parts[3] !== undefined) {
      const ja = params.get("ja");
      return { page: "term", id: parts[1], src: parts[3], ...(ja === null ? {} : { ja }) };
    }
    return { page: "paper", id: parts[1] };
  }
  return { page: "papers" };
}

export const href = {
  papers: () => "#/",
  paper: (id: string) => `#/papers/${encodeURIComponent(id)}`,
  term: (id: string, src: string, ja?: string) =>
    `#/papers/${encodeURIComponent(id)}/terms/${encodeURIComponent(src)}${
      ja === undefined ? "" : `?ja=${encodeURIComponent(ja)}`
    }`,
  glossary: () => "#/glossary",
};

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const on = () => {
      setRoute(parseRoute(window.location.hash));
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}
