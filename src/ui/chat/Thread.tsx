// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useSignal } from "@preact/signals";
import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import { Diagram } from "./Diagram.tsx";
import { Empty } from "./Empty.tsx";
import { Reply } from "./Reply.tsx";
import { Summary } from "./Summary.tsx";
import { copy, current, tree } from "./store.ts";
import type { Node } from "./thread.ts";
import { UserRow } from "./UserRow.tsx";
import { Work } from "./Work.tsx";

export function Row({ node }: { node: Node }) {
  if (node.kind === "user") return <UserRow message={node.message} />;
  if (node.kind === "work") return <Work node={node} />;
  if (node.kind === "summary") return <Summary node={node} />;
  return (
    <Reply
      message={node.message}
      live={node.live}
      think={node.think}
      tools={node.tools}
      last={node.last}
    />
  );
}

const keyOf = (n: Node) => (n.kind === "work" ? n.key : `m-${n.message.id}`);

// The transcript and its scroll box. Following the reply: only a scroll
// upwards lets go, because a programmatic scroll only ever moves down.
// The scroll event is async, so judging by the gap alone unsticks when a
// rendered block lands before the event for the previous scroll fires. A
// shrink (raw markdown replaced by its shorter rendering) clamps
// scrollTop down without anyone scrolling, so a decrease counts only
// while the height did not drop.
export function Thread() {
  const scroll = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastTop = useRef(0);
  const lastHeight = useRef(0);
  const jumpHidden = useSignal(true);
  const diagram = useSignal<string | null>(null);
  const nodes = tree.value;
  const chat = current.value;
  // a new user or assistant row sticks the view to the bottom again; a
  // tool row lands inside a block and must not pull a reader back down
  const count = chat?.messages.filter((m) => m.role !== "tool").length ?? 0;

  useEffect(() => {
    const el = scroll.current;
    if (!el) return;
    const onScroll = () => {
      const top = el.scrollTop;
      const height = el.scrollHeight;
      const gap = height - top - el.clientHeight;
      if (top < lastTop.current - 1 && height >= lastHeight.current) {
        stick.current = false;
      } else if (gap < 40) stick.current = true;
      lastTop.current = top;
      lastHeight.current = height;
      jumpHidden.value = stick.current || gap < 80;
    };
    el.addEventListener("scroll", onScroll);
    // Block controls arrive inside the server's HTML, so one delegated
    // listener serves Copy and the diagram's full-screen button.
    const timers = new Map<Element, ReturnType<typeof setTimeout>>();
    let listening = true;
    const onClick = async (ev: MouseEvent) => {
      if (!(ev.target instanceof Element)) return;
      const b = ev.target.closest("button.copy, button.expand");
      if (!b) return;
      if (b.matches("button.expand")) {
        const image = b
          .closest(".code")
          ?.querySelector<HTMLImageElement>("img.diagram");
        if (image) diagram.value = image.src;
        return;
      }
      const pre = b.closest(".code")?.querySelector("pre");
      if (!pre) return;
      if (!(await copy(pre.textContent ?? ""))) return;
      if (!listening || !b.isConnected) return;
      clearTimeout(timers.get(b));
      b.classList.add("copied");
      b.setAttribute("title", "Copied");
      b.setAttribute("aria-label", "Copied");
      timers.set(
        b,
        setTimeout(() => {
          timers.delete(b);
          b.classList.remove("copied");
          b.setAttribute("title", "Copy");
          b.setAttribute("aria-label", "Copy block");
        }, 1200),
      );
    };
    el.addEventListener("click", onClick);
    return () => {
      listening = false;
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("click", onClick);
      for (const t of timers.values()) clearTimeout(t);
    };
  }, [diagram, jumpHidden]);

  // a chat opens at its end; a new row sticks the view to the bottom again
  const chatId = chat?.id ?? null;
  useLayoutEffect(() => {
    const el = scroll.current;
    if (!el) return;
    diagram.value = null;
    stick.current = true;
    el.scrollTop = el.scrollHeight;
    lastTop.current = el.scrollTop;
    lastHeight.current = el.scrollHeight;
    jumpHidden.value = true;
  }, [chatId, diagram, jumpHidden]);
  useLayoutEffect(() => {
    stick.current = true;
  }, [count]);
  useLayoutEffect(() => {
    const el = scroll.current;
    if (!el || !stick.current) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  });

  return (
    <>
      <div class="scroll" ref={scroll}>
        <div class="thread">
          {nodes.map((n) => (
            <Row key={keyOf(n)} node={n} />
          ))}
        </div>
        {chat === null && <Empty />}
      </div>
      <button
        type="button"
        class="jump"
        hidden={jumpHidden.value}
        onClick={() => {
          stick.current = true;
          scroll.current?.scrollTo({
            top: scroll.current.scrollHeight,
            behavior: "smooth",
          });
        }}
      >
        Jump to latest
      </button>
      {diagram.value !== null && (
        <Diagram
          src={diagram.value}
          title={chat?.title || "New chat"}
          onClose={() => {
            diagram.value = null;
          }}
        />
      )}
    </>
  );
}
