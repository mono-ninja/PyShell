import type { JSX } from "preact";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useToast } from "../components/Toast";

/**
 * A small Markdown renderer for script READMEs.
 *
 * It builds Preact nodes directly and never touches `dangerouslySetInnerHTML`.
 * A README is untrusted input authored by whoever wrote the script, and this
 * webview can invoke Tauri commands — so no path here turns README text into
 * markup. The CSP already blocks inline scripts; this removes the question.
 *
 * Deliberately a subset: headings, paragraphs, fenced and indented code, lists,
 * blockquotes, rules, pipe tables, and inline code/bold/italic/links. Anything
 * unrecognised falls through as plain text rather than being dropped.
 */

/** Only schemes that can't execute anything. `javascript:` must never survive. */
const SAFE_SCHEME = /^(https?:|mailto:)/i;

/** Exported for tests — this is security-sensitive logic (Plan.md §1.7). */
export function isSafeHref(href: string): boolean {
  const trimmed = href.trim();
  if (trimmed.startsWith("#") || trimmed.startsWith("/") || trimmed.startsWith("./")) {
    // Relative links have nowhere to go in this panel; render them as text.
    return false;
  }
  return SAFE_SCHEME.test(trimmed);
}

/**
 * A link that hands the URL to the OS instead of navigating the webview.
 * Exported because the chrome needs it too (the sidebar's empty state), and a
 * second copy would be a second place to forget `preventDefault`.
 */
export function ExternalLink({ href, children }: { href: string; children: preact.ComponentChildren }) {
  const { notifyError } = useToast();
  return (
    <a
      href={href}
      class="text-accent underline decoration-accent/30 underline-offset-2 hover:decoration-accent"
      onClick={(e) => {
        // Never navigate the webview itself — hand the URL to the OS.
        e.preventDefault();
        openUrl(href).catch((err) => notifyError(err, "Open URL failed"));
      }}
    >
      {children}
    </a>
  );
}

// --- inline ----------------------------------------------------------------

/**
 * Inline spans, in precedence order: code (which suppresses everything inside
 * it), then links, then strong, then emphasis.
 */
function renderInline(text: string, keyPrefix: string): JSX.Element[] {
  const out: JSX.Element[] = [];
  let buffer = "";
  let i = 0;
  let k = 0;

  const flush = () => {
    if (buffer) {
      out.push(<span key={`${keyPrefix}-t${k++}`}>{buffer}</span>);
      buffer = "";
    }
  };

  while (i < text.length) {
    const rest = text.slice(i);

    // `code`
    const code = /^`([^`]+)`/.exec(rest);
    if (code) {
      flush();
      out.push(
        <code
          key={`${keyPrefix}-c${k++}`}
          class="rounded bg-fg/[0.08] px-1 py-px font-mono text-[0.9em]"
        >
          {code[1]}
        </code>,
      );
      i += code[0].length;
      continue;
    }

    // [label](href)
    const link = /^\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(rest);
    if (link) {
      flush();
      const [, label, href] = link;
      const text = label || href;
      if (isSafeHref(href)) {
        out.push(
          <ExternalLink key={`${keyPrefix}-l${k++}`} href={href.trim()}>
            {renderInline(text, `${keyPrefix}-l${k}`)}
          </ExternalLink>,
        );
      } else {
        out.push(<span key={`${keyPrefix}-l${k++}`}>{text}</span>);
      }
      i += link[0].length;
      continue;
    }

    // Bare URL
    const auto = /^<?(https?:\/\/[^\s<>)]+)>?/.exec(rest);
    if (auto) {
      flush();
      out.push(
        <ExternalLink key={`${keyPrefix}-a${k++}`} href={auto[1]}>
          {auto[1]}
        </ExternalLink>,
      );
      i += auto[0].length;
      continue;
    }

    // **strong** / __strong__
    const strong = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest);
    if (strong) {
      flush();
      out.push(
        <strong key={`${keyPrefix}-s${k++}`} class="font-semibold text-fg">
          {renderInline(strong[2], `${keyPrefix}-s${k}`)}
        </strong>,
      );
      i += strong[0].length;
      continue;
    }

    // *em* / _em_
    const em = /^(\*|_)(?=\S)([\s\S]*?\S)\1/.exec(rest);
    if (em) {
      flush();
      out.push(
        <em key={`${keyPrefix}-e${k++}`} class="italic">
          {renderInline(em[2], `${keyPrefix}-e${k}`)}
        </em>,
      );
      i += em[0].length;
      continue;
    }

    // ~~strike~~
    const del = /^~~(?=\S)([\s\S]*?\S)~~/.exec(rest);
    if (del) {
      flush();
      out.push(
        <span key={`${keyPrefix}-d${k++}`} class="line-through opacity-70">
          {renderInline(del[1], `${keyPrefix}-d${k}`)}
        </span>,
      );
      i += del[0].length;
      continue;
    }

    buffer += text[i];
    i += 1;
  }

  flush();
  return out;
}

// --- blocks ----------------------------------------------------------------

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  return (
    <div class="my-2.5 overflow-hidden rounded-lg border border-line bg-surface">
      {lang && (
        <div class="border-b border-line px-3 py-1 font-mono text-2xs text-subtle">{lang}</div>
      )}
      <pre class="overflow-x-auto p-3 font-mono text-xs leading-relaxed">{code}</pre>
    </div>
  );
}

/** Exported for tests — table row splitting logic. */
export function splitRow(line: string): string[] {
  return line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((c) => c.trim());
}

const HEADING_CLASS: Record<number, string> = {
  1: "mt-4 mb-2 text-[17px] font-semibold tracking-tight",
  2: "mt-4 mb-1.5 text-[15px] font-semibold tracking-tight",
  3: "mt-3 mb-1 text-[14px] font-semibold",
  4: "mt-3 mb-1 text-[13px] font-semibold",
  5: "mt-2 mb-1 text-[13px] font-semibold text-muted",
  6: "mt-2 mb-1 text-2xs font-semibold uppercase tracking-wider text-subtle",
};

export function renderMarkdown(source: string): JSX.Element[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: JSX.Element[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Blank
    if (!line.trim()) {
      i += 1;
      continue;
    }

    // Fenced code
    const fence = /^\s*(```|~~~)\s*([\w+-]*)/.exec(line);
    if (fence) {
      const marker = fence[1];
      const lang = fence[2];
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trimStart().startsWith(marker)) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // closing fence (or EOF)
      blocks.push(<CodeBlock key={`b${key++}`} lang={lang} code={body.join("\n")} />);
      continue;
    }

    // Heading
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const Tag = `h${level}` as keyof JSX.IntrinsicElements;
      blocks.push(
        <Tag key={`b${key++}`} class={HEADING_CLASS[level]}>
          {renderInline(heading[2].replace(/\s+#+\s*$/, ""), `h${key}`)}
        </Tag>,
      );
      i += 1;
      continue;
    }

    // Horizontal rule
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      blocks.push(<hr key={`b${key++}`} class="my-3 border-line" />);
      i += 1;
      continue;
    }

    // Pipe table: header row followed by a delimiter row
    if (line.includes("|") && i + 1 < lines.length && /^[\s|:-]+$/.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      const header = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      blocks.push(
        <div key={`b${key++}`} class="my-2.5 overflow-x-auto rounded-lg border border-line">
          <table class="w-full border-collapse text-xs">
            <thead>
              <tr class="bg-fg/[0.04]">
                {header.map((h, hi) => (
                  <th
                    key={hi}
                    class="whitespace-nowrap border-b border-line px-2.5 py-1.5 text-left font-semibold text-muted"
                  >
                    {renderInline(h, `th${key}-${hi}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, ci) => (
                    <td key={ci} class="border-b border-line/60 px-2.5 py-1.5 align-top">
                      {renderInline(c, `td${key}-${ri}-${ci}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // Blockquote
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        body.push(lines[i].replace(/^\s*>\s?/, ""));
        i += 1;
      }
      blocks.push(
        <blockquote
          key={`b${key++}`}
          class="my-2.5 border-l-2 border-accent/40 pl-3 text-muted"
        >
          {renderMarkdown(body.join("\n"))}
        </blockquote>,
      );
      continue;
    }

    // Lists (a run of items; nesting is flattened)
    const listItem = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (listItem) {
      const ordered = /\d/.test(listItem[2]);
      const items: string[] = [];
      while (i < lines.length) {
        const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (m) {
          items.push(m[3]);
          i += 1;
        } else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) {
          // Continuation of the previous item.
          items[items.length - 1] += ` ${lines[i].trim()}`;
          i += 1;
        } else {
          break;
        }
      }
      const Tag = ordered ? "ol" : "ul";
      blocks.push(
        <Tag
          key={`b${key++}`}
          class={`my-2 space-y-1 pl-5 ${ordered ? "list-decimal" : "list-disc"} marker:text-subtle`}
        >
          {items.map((it, idx) => (
            <li key={idx} class="leading-relaxed">
              {renderInline(it, `li${key}-${idx}`)}
            </li>
          ))}
        </Tag>,
      );
      continue;
    }

    // Paragraph: consume until a blank line or the start of another block
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,6}\s|\s*(```|~~~)|\s*>)/.test(lines[i]) &&
      !/^(\s*)([-*+]|\d+[.)])\s+/.test(lines[i])
    ) {
      para.push(lines[i]);
      i += 1;
    }
    if (para.length) {
      blocks.push(
        <p key={`b${key++}`} class="my-2 leading-relaxed">
          {renderInline(para.join(" "), `p${key}`)}
        </p>,
      );
      continue;
    }

    i += 1;
  }

  return blocks;
}
