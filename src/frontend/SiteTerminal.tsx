import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useTranslation, type TabProps } from "@termix-ssh/plugin-sdk/frontend";
import { getApp } from "./app";

type Prompt = {
  label: string;
  hidden: boolean;
  /** What to send when the line is entered. */
  reply: (line: string) => { type: string; data?: unknown } | null;
};

/** The sign in steps a host can ask for, answered on the terminal itself. */
function promptFor(message: {
  type: string;
  prompt?: string;
  echo?: boolean;
  isPush?: boolean;
}): Prompt | null {
  switch (message.type) {
    case "host_key_verification_required":
    case "host_key_changed":
      return {
        label:
          message.type === "host_key_changed"
            ? "The host key changed. Trust it anyway? (yes/no): "
            : "Unknown host key. Trust it? (yes/no): ",
        hidden: false,
        reply: (line) => ({
          type: "host_key_verification_response",
          data: { action: /^y/i.test(line) ? "accept" : "reject" },
        }),
      };
    case "auth_method_not_available":
      return {
        label: "Password: ",
        hidden: true,
        reply: (line) => ({
          type: "reconnect_with_credentials",
          data: { password: line },
        }),
      };
    case "passphrase_required":
      return {
        label: "Key passphrase: ",
        hidden: true,
        reply: (line) => ({
          type: "reconnect_with_credentials",
          data: { keyPassword: line },
        }),
      };
    case "totp_required":
    case "totp_retry":
      return {
        label:
          message.type === "totp_retry"
            ? "That code did not work. Verification code: "
            : `${message.prompt?.trim() || "Verification code:"} `,
        hidden: true,
        reply: (line) => ({ type: "totp_response", data: { code: line } }),
      };
    case "password_required":
      return {
        label: message.isPush
          ? "Approve the sign in on your device, then press Enter: "
          : `${message.prompt?.trim() || "Password:"} `,
        hidden: !message.echo && !message.isPush,
        reply: (line) => ({ type: "password_response", data: { code: line } }),
      };
    default:
      return null;
  }
}

export function SiteTerminal({ tab, isVisible }: TabProps) {
  const { t } = useTranslation();
  const host = useRef<HTMLDivElement>(null);
  const fit = useRef<FitAddon | null>(null);
  const [state, setState] = useState<"connecting" | "open" | "closed">(
    "connecting",
  );
  const siteId = Number(tab.data?.siteId);
  const hostId = Number(tab.data?.hostId);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      scrollback: 5000,
      convertEol: true,
    });
    const addon = new FitAddon();
    fit.current = addon;
    term.loadAddon(addon);
    term.open(element);
    addon.fit();

    let socket: WebSocket | null = null;
    let ping: ReturnType<typeof setInterval> | null = null;
    let disposed = false;
    let prompt: Prompt | null = null;
    let line = "";

    const send = (type: string, data?: unknown) => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(
          JSON.stringify(data === undefined ? { type } : { type, data }),
        );
      }
    };

    void (async () => {
      const target = await getApp().wsUrl(
        `/site-terminal?siteId=${siteId}&hostId=${hostId}&cols=${term.cols}&rows=${term.rows}`,
      );
      if (disposed) return;
      if (!target) {
        setState("closed");
        term.writeln(t("sites.terminal.unavailable"));
        return;
      }
      socket = new WebSocket(target.url, target.protocols);
      socket.onopen = () => {
        setState("open");
        ping = setInterval(() => send("ping"), 30_000);
      };
      socket.onmessage = (event) => {
        let message: {
          type: string;
          data?: unknown;
          message?: string;
          prompt?: string;
          echo?: boolean;
          isPush?: boolean;
        };
        try {
          message = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (message.type === "data") {
          term.write(String(message.data ?? ""));
          return;
        }
        if (message.type === "error") {
          term.writeln(`\r\n${message.message ?? t("sites.terminal.failed")}`);
          return;
        }
        const next = promptFor(message);
        if (next) {
          prompt = next;
          line = "";
          term.write(`\r\n${next.label}`);
        }
      };
      socket.onclose = () => {
        setState("closed");
        if (ping) clearInterval(ping);
        term.writeln(`\r\n${t("sites.terminal.closed")}`);
      };
    })();

    term.onData((data) => {
      if (!prompt) {
        send("input", data);
        return;
      }
      for (const char of data) {
        if (char === "\r" || char === "\n") {
          const reply = prompt.reply(line);
          prompt = null;
          line = "";
          term.write("\r\n");
          if (reply) send(reply.type, reply.data);
        } else if (char === "\u007f") {
          if (line.length > 0) {
            line = line.slice(0, -1);
            if (!prompt.hidden) term.write("\b \b");
          }
        } else if (char >= " ") {
          line += char;
          if (!prompt.hidden) term.write(char);
        }
      }
    });
    term.onResize(({ cols, rows }) => send("resize", { cols, rows }));

    const observer = new ResizeObserver(() => {
      try {
        addon.fit();
      } catch {
        // The tab can be hidden while it resizes.
      }
    });
    observer.observe(element);

    return () => {
      disposed = true;
      observer.disconnect();
      if (ping) clearInterval(ping);
      send("disconnect");
      socket?.close();
      term.dispose();
    };
  }, [siteId, hostId, t]);

  useEffect(() => {
    if (isVisible) fit.current?.fit();
  }, [isVisible]);

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="px-3 py-1 text-xs text-muted-foreground">
        {state === "connecting" && t("sites.terminal.connecting")}
        {state === "open" && t("sites.terminal.open")}
        {state === "closed" && t("sites.terminal.closed")}
      </div>
      <div ref={host} className="min-h-0 flex-1 px-2" />
    </div>
  );
}
