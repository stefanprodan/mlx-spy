// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Chat page: the list, the conversation and the settings dialog,
// rendered into the frame that fills the viewport.

import { useEffect, useState } from "preact/hooks";
import { Composer } from "./Composer.tsx";
import { Header } from "./Header.tsx";
import { List } from "./List.tsx";
import { listClosed, rememberList } from "./nav.ts";
import { Settings } from "./Settings.tsx";
import { Thread } from "./Thread.tsx";

const phone = () => matchMedia("(max-width: 760px)").matches;

export function Chat({ frame }: { frame: HTMLElement }) {
  const [drawer, setDrawer] = useState(false);
  const [settings, setSettings] = useState(false);
  const [closed, setClosed] = useState(listClosed);
  useEffect(() => {
    frame.classList.toggle("nolist", closed);
  }, [frame, closed]);
  const onList = () => {
    if (phone()) {
      setDrawer((d) => !d);
      return;
    }
    setClosed((c) => {
      rememberList(!c);
      return !c;
    });
  };
  return (
    <>
      <List open={drawer} onPick={() => setDrawer(false)} />
      <section class="conv">
        <Header onList={onList} onSettings={() => setSettings(true)} />
        <Thread />
        <Composer />
      </section>
      <Settings open={settings} onClose={() => setSettings(false)} />
    </>
  );
}
