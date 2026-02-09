/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { addContextMenuPatch, removeContextMenuPatch } from "@api/ContextMenu";
import { Devs } from "@utils/constants";
import { Modals, openModal } from "@utils/modal";
import definePlugin from "@utils/types";
import { findByPropsLazy } from "@webpack";
import {
    Button,
    Forms,
    Menu,
    MessageStore,
    React,
    TextInput,
    UserStore
} from "@webpack/common";

// Discord internal actions (signatures can vary)
const MessageActions = findByPropsLazy("deleteMessage", "fetchMessages");

// Stores
const ChannelStore = findByPropsLazy("getChannel");
const SelectedChannelStore = findByPropsLazy("getChannelId");

const MENU_IDS = [
    "channel-context",
    "thread-context",
    "dm-context",
    "gdm-context",
    "private-channel-context",
    "private-channel-user-context",
    "private-channel-recipient-context",
    "private-channel-list-context",
    "user-context",
    "friends-user-context",
    "friend-row-context"
];

type TargetChannel = { id: string; name?: string; type?: number; };

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function snowflakeToDate(id: string): Date {
    try {
        const discordEpoch = 1420070400000n;
        const ts = (BigInt(id) >> 22n) + discordEpoch;
        return new Date(Number(ts));
    } catch {
        return new Date();
    }
}

function fmt(dt: Date) {
    try {
        return dt.toLocaleString("en-US");
    } catch {
        return dt.toISOString();
    }
}

function safeSnippet(content?: string) {
    const s = (content ?? "").replace(/\s+/g, " ").trim();
    if (!s) return "<empty>";
    return s.length > 140 ? s.slice(0, 140) + "…" : s;
}

function getCachedMessages(channelId: string): any[] {
    const store = MessageStore.getMessages(channelId);
    if (!store) return [];

    try {
        if (typeof store.toArray === "function") return store.toArray();
    } catch { }

    try {
        if (Array.isArray((store as any)._array)) return (store as any)._array;
    } catch { }

    try {
        const msgs = (store as any)._map ?? (store as any)._messages ?? (store as any).messages;
        if (msgs) {
            if (typeof msgs.values === "function") return Array.from(msgs.values());
            if (Array.isArray(msgs)) return msgs;
            if (typeof msgs === "object") return Object.values(msgs);
        }
    } catch { }

    try {
        if (typeof (store as any)[Symbol.iterator] === "function") return Array.from(store as any);
    } catch { }

    return [];
}

async function tryFetchMore(channelId: string, beforeId?: string): Promise<boolean> {
    try {
        const fn = (MessageActions as any)?.fetchMessages;
        if (typeof fn !== "function") return false;

        try {
            await fn({ channelId, limit: 100, before: beforeId });
            return true;
        } catch { }

        try {
            await fn(channelId, beforeId, 100);
            return true;
        } catch { }

        try {
            await fn(channelId, { before: beforeId, limit: 100 });
            return true;
        } catch { }

        return false;
    } catch {
        return false;
    }
}

function getChannelFromContextMenuArgs(args: any[]): TargetChannel | null {
    for (const a of args) {
        if (!a) continue;

        if (a?.channel?.id) return a.channel as TargetChannel;

        if (a?.id && typeof a.id === "string" && !a?.user) return a as TargetChannel;

        const cid = a?.channelId ?? a?.props?.channelId;
        if (cid && typeof cid === "string") {
            try {
                const ch = ChannelStore.getChannel(cid);
                if (ch?.id) return ch;
            } catch { }
        }

        if (a?.props?.channel?.id) return a.props.channel as TargetChannel;
    }

    try {
        const id = SelectedChannelStore.getChannelId?.();
        if (id) {
            const ch = ChannelStore.getChannel(id);
            if (ch?.id) return ch;
        }
    } catch { }

    return null;
}

function DmClearModal(modalProps: any & { channel: TargetChannel; }) {
    const { channel } = modalProps;
    const me = UserStore.getCurrentUser();

    const ModalRoot = (Modals as any)?.ModalRoot;
    const ModalHeader = (Modals as any)?.ModalHeader;
    const ModalContent = (Modals as any)?.ModalContent;
    const ModalFooter = (Modals as any)?.ModalFooter;

    if (!ModalRoot || !ModalHeader || !ModalContent || !ModalFooter) {
        return (
            <div style={{ padding: 16 }}>
                <Forms.FormTitle tag="h2">DmClear</Forms.FormTitle>
                <Forms.FormText>
                    Error: Modal components are missing in this build (Modals.ModalRoot/... not found).
                </Forms.FormText>
                <div style={{ marginTop: 12, display: "flex", justifyContent: "flex-end" }}>
                    <Button onClick={modalProps?.onClose}>Close</Button>
                </div>
            </div>
        );
    }

    const [countStr, setCountStr] = React.useState("50");
    const [logs, setLogs] = React.useState<string[]>([]);
    const [running, setRunning] = React.useState(false);

    const logsRef = React.useRef<HTMLTextAreaElement | null>(null);

    const pushLog = React.useCallback((line: string) => {
        setLogs(prev => [...prev, `[${fmt(new Date())}] ${line}`]);
    }, []);

    React.useEffect(() => {
        const el = logsRef.current;
        if (!el) return;
        el.scrollTop = el.scrollHeight;
    }, [logs]);

    const doDelete = React.useCallback(async () => {
        const requested = Number.parseInt(countStr, 10);
        const limit = Number.isFinite(requested) ? Math.max(1, Math.min(5000, requested)) : 0;

        if (!limit) {
            pushLog("⚠️ Warning: Invalid message count.");
            return;
        }

        setRunning(true);
        pushLog(`▶️ Started | Channel=${channel.name ?? channel.id} | Requested=${limit} | User=${me?.username ?? me?.id}`);

        let deleted = 0;
        const seen = new Set<string>();

        try {
            while (deleted < limit) {
                const cached = getCachedMessages(channel.id);

                if (!cached.length) {
                    pushLog("⚠️ Warning: Cache is empty. Trying to fetch older messages...");
                    const ok = await tryFetchMore(channel.id, undefined);
                    if (!ok) {
                        pushLog("❌ Error: fetchMessages is unavailable/failed. Cannot retrieve older messages.");
                        break;
                    }
                    await sleep(800);
                    continue;
                }

                const sorted = [...cached].sort((a, b) => {
                    const at = a?.timestamp ? new Date(a.timestamp).getTime() : snowflakeToDate(String(a?.id)).getTime();
                    const bt = b?.timestamp ? new Date(b.timestamp).getTime() : snowflakeToDate(String(b?.id)).getTime();
                    return bt - at;
                });

                const mine = sorted.filter(m => m?.author?.id === me?.id && m?.id && !seen.has(String(m.id)));

                if (!mine.length) {
                    const oldest = sorted[sorted.length - 1]?.id ? String(sorted[sorted.length - 1].id) : undefined;
                    pushLog("⚠️ Warning: No more of your messages in cache. Fetching older...");
                    const ok = await tryFetchMore(channel.id, oldest);
                    if (!ok) {
                        pushLog("✅ Done: No more messages could be fetched/found.");
                        break;
                    }
                    await sleep(900);
                    continue;
                }

                for (const msg of mine) {
                    if (deleted >= limit) break;

                    const id = String(msg.id);
                    seen.add(id);

                    const msgTime = msg.timestamp ? new Date(msg.timestamp) : snowflakeToDate(id);
                    const delTime = new Date();

                    try {
                        (MessageActions as any).deleteMessage(channel.id, id);
                        deleted++;

                        pushLog(
                            `🗑️ Deleted (${deleted}/${limit}) | MsgTime=${fmt(msgTime)} | DeletedAt=${fmt(delTime)} | "${safeSnippet(msg.content)}"`
                        );

                        await sleep(1100);
                    } catch (e: any) {
                        pushLog(`❌ Error: deleteMessage failed (id=${id}) -> ${String(e?.message ?? e)}`);
                        await sleep(1500);
                    }
                }
            }

            pushLog(`🏁 Summary: Deleted=${deleted} / Requested=${limit}`);
        } catch (e: any) {
            pushLog(`❌ Fatal error: ${String(e?.message ?? e)}`);
        } finally {
            setRunning(false);
        }
    }, [countStr, pushLog, channel.id, channel.name, me?.id, me?.username]);

    // Stop propagation only (NO preventDefault) so selection/clicks work normally.
    const stopBubble = (e: any) => {
        try { e?.stopPropagation?.(); } catch { }
    };

    const size = (Modals as any)?.ModalSize?.MEDIUM ?? (Modals as any)?.ModalSize?.SMALL;

    return (
        <ModalRoot {...modalProps} size={size}>
            <ModalHeader>
                <Forms.FormTitle tag="h2">DmClear</Forms.FormTitle>
            </ModalHeader>

            <ModalContent>
                <div onMouseDown={stopBubble} onClick={stopBubble} onPointerDown={stopBubble}>
                    {/* Replaced Forms.FormSection with divs to satisfy tsc */}
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        <Forms.FormTitle tag="h3">How many messages will be deleted?</Forms.FormTitle>
                        <TextInput
                            value={countStr}
                            onChange={(v: string) => setCountStr(v)}
                            placeholder="e.g. 50"
                            disabled={running}
                        />
                    </div>

                    <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
                        <Forms.FormTitle tag="h3">Logs</Forms.FormTitle>

                        {/* Plain textarea to avoid Discord input styling */}
                        <textarea
                            ref={logsRef}
                            value={logs.join("\n")}
                            readOnly
                            spellCheck={false}
                            style={{
                                width: "100%",
                                height: 320,
                                resize: "vertical",
                                boxSizing: "border-box",
                                padding: "12px",
                                borderRadius: "8px",
                                border: "1px solid rgba(255,255,255,0.14)",
                                background: "rgba(0,0,0,0.55)",
                                color: "rgba(255,255,255,0.92)",
                                caretColor: "rgba(255,255,255,0.92)",
                                fontFamily:
                                    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, \"Liberation Mono\", \"Courier New\", monospace",
                                fontSize: "12px",
                                lineHeight: "18px",
                                whiteSpace: "pre",
                                overflow: "auto",
                                outline: "none"
                            }}
                        />
                    </div>
                </div>
            </ModalContent>

            <ModalFooter>
                <div
                    onMouseDown={stopBubble}
                    onClick={stopBubble}
                    onPointerDown={stopBubble}
                    style={{
                        display: "flex",
                        justifyContent: "flex-end",
                        gap: 8,
                        width: "100%"
                    }}
                >
                    <Button
                        look={Button.Looks.LINK}
                        color={Button.Colors.PRIMARY}
                        onClick={modalProps?.onClose}
                        disabled={running}
                    >
                        Close
                    </Button>

                    <Button onClick={doDelete} disabled={running}>
                        Delete
                    </Button>
                </div>
            </ModalFooter>
        </ModalRoot>
    );
}

function openDmClearModal(channel: TargetChannel) {
    // Defer so the context menu close can't interfere
    setTimeout(() => {
        requestAnimationFrame(() => {
            openModal((props: any) => <DmClearModal {...props} channel={channel} />, undefined);
        });
    }, 0);
}

function contextMenuPatch(children: any[], ...args: any[]) {
    const ch = getChannelFromContextMenuArgs(args);
    if (!ch?.id) return;

    children.push(
        <Menu.MenuGroup key="vc-dmclear-group">
            <Menu.MenuItem
                id="vc-dmclear-bulk-delete"
                label="Bulk Delete My Messages"
                action={(e: any) => {
                    try { e?.stopPropagation?.(); } catch { }
                    openDmClearModal(ch);
                }}
            />
        </Menu.MenuGroup>
    );
}

export default definePlugin({
    name: "DmClear",
    description: "Discord bulk message deleter.",
    authors: [Devs.sikilmem],

    start() {
        for (const id of MENU_IDS) addContextMenuPatch(id, contextMenuPatch);
    },

    stop() {
        for (const id of MENU_IDS) removeContextMenuPatch(id, contextMenuPatch);
    }
});
