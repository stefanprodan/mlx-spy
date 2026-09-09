// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Syntax highlighting for the fenced blocks of a reply, on the server, so
// the page ships no grammar. highlight.js is bundled with a curated set of
// languages (the full set is 190) and escapes every token itself; the
// caller passes raw text and gets HTML, and a language it does not know
// gets no markup at all (auto-detection is not worth its false colours on
// a model's output). The classes are highlight.js's own (hljs-keyword,
// hljs-string, ...) and style.css maps them onto the palette.

import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import dart from "highlight.js/lib/languages/dart";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import elixir from "highlight.js/lib/languages/elixir";
import go from "highlight.js/lib/languages/go";
import graphql from "highlight.js/lib/languages/graphql";
import haskell from "highlight.js/lib/languages/haskell";
import http from "highlight.js/lib/languages/http";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import lua from "highlight.js/lib/languages/lua";
import makefile from "highlight.js/lib/languages/makefile";
import nginx from "highlight.js/lib/languages/nginx";
import nix from "highlight.js/lib/languages/nix";
import objectivec from "highlight.js/lib/languages/objectivec";
import perl from "highlight.js/lib/languages/perl";
import php from "highlight.js/lib/languages/php";
import powershell from "highlight.js/lib/languages/powershell";
import protobuf from "highlight.js/lib/languages/protobuf";
import python from "highlight.js/lib/languages/python";
import r from "highlight.js/lib/languages/r";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scala from "highlight.js/lib/languages/scala";
import scss from "highlight.js/lib/languages/scss";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

const LANGUAGES = {
  bash,
  c,
  cpp,
  csharp,
  css,
  dart,
  diff,
  dockerfile,
  elixir,
  go,
  graphql,
  haskell,
  http,
  ini,
  java,
  javascript,
  json,
  kotlin,
  lua,
  makefile,
  nginx,
  nix,
  objectivec,
  perl,
  php,
  powershell,
  protobuf,
  python,
  r,
  ruby,
  rust,
  scala,
  scss,
  shell,
  sql,
  swift,
  typescript,
  xml,
  yaml,
};

for (const [name, language] of Object.entries(LANGUAGES)) {
  hljs.registerLanguage(name, language);
}

// Names models write that the grammars above do not list as aliases (the
// common ones, jsonc, zsh, proto, svg, they do).
hljs.registerAliases(["terminal"], { languageName: "shell" });
hljs.registerAliases(["python3", "py3"], { languageName: "python" });
hljs.registerAliases(["objective-c"], { languageName: "objectivec" });

export const MAX_BYTES = 32 * 1024;

// Escaped HTML for the text, or null when the language is unknown or the
// block is too big, so the caller keeps its own escaping. A grammar bug
// must never lose a reply: highlight.js throws on nothing it knows, and
// the null covers the rest.
export function highlight(text: string, language: string): string | null {
  if (text.length > MAX_BYTES || !hljs.getLanguage(language)) return null;
  try {
    return hljs.highlight(text, { language, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}
