"use client";
import { useEffect } from "react";
import { translateText } from "@/lib/i18n/eg";
import { useUi } from "./providers";

/*
 * Egyptian Arabic mode. Translates visible text (and placeholders, titles, aria-labels) from the English UI using a
 * reviewed dictionary plus patterns for sentences that contain numbers. Anything not in the dictionary stays English
 * rather than being machine-guessed. User-typed values (inputs, textareas) are never touched.
 */
const ATTRS = ["placeholder", "title", "aria-label"];
const SKIP = "script,style,code,pre,textarea,[data-no-translate]";

export function AutoTranslate() {
  const { locale } = useUi();
  useEffect(() => {
    if (locale !== "ar") return;
    const mine = new WeakMap<Node, string>();
    const textNode = (n: Text) => {
      const v = n.nodeValue ?? "";
      if (!v.trim() || mine.get(n) === v) return;
      if (n.parentElement?.closest(SKIP)) return;
      const r = translateText(v);
      if (r !== null && r !== v) {
        mine.set(n, r);
        n.nodeValue = r;
      }
    };
    const element = (el: Element) => {
      if (el.closest(SKIP)) return;
      for (const a of ATTRS) {
        const v = el.getAttribute(a);
        if (!v) continue;
        const r = translateText(v);
        if (r !== null && r !== v) el.setAttribute(a, r);
      }
    };
    const walk = (root: Node) => {
      if (root.nodeType === Node.TEXT_NODE) return textNode(root as Text);
      if (root.nodeType !== Node.ELEMENT_NODE) return;
      element(root as Element);
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        if (n.nodeType === Node.TEXT_NODE) textNode(n as Text);
        else element(n as Element);
      }
    };
    walk(document.body);
    const title = translateText(document.title);
    if (title) document.title = title;
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === "characterData") textNode(m.target as Text);
        else if (m.type === "attributes") element(m.target as Element);
        else m.addedNodes.forEach(walk);
      }
    });
    mo.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ATTRS,
    });
    return () => mo.disconnect();
  }, [locale]);
  return null;
}
