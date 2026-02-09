/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";
import { findByPropsLazy } from "@webpack";
import { ChannelStore, Menu, PermissionsBits, PermissionStore, React, RestAPI, UserStore, VoiceStateStore } from "@webpack/common";

interface UserSettings {
    unmute: boolean;
    undeafen: boolean;
    rejoinOnDisconnect: boolean;
}

const userSettings = new Map<string, UserSettings>();

/** Last voice channel (only for self rejoin on disconnect). */
let lastChannelIdSelf: string | null = null;

const ChannelActions = findByPropsLazy("selectVoiceChannel", "disconnect");

function getUserSettings(userId: string): UserSettings {
    if (!userSettings.has(userId)) {
        userSettings.set(userId, { unmute: false, undeafen: false, rejoinOnDisconnect: false });
    }
    return userSettings.get(userId)!;
}

function setUserSettings(userId: string, settings: UserSettings) {
    userSettings.set(userId, settings);
}

function clearUserSettings(userId: string) {
    userSettings.delete(userId);
}

function getUsersWithPermanentOperations(): Array<{ userId: string; settings: UserSettings; }> {
    const users: Array<{ userId: string; settings: UserSettings; }> = [];
    for (const [userId, settings] of userSettings.entries()) {
        if (settings.unmute || settings.undeafen || settings.rejoinOnDisconnect) {
            users.push({ userId, settings });
        }
    }
    return users;
}

function getUserDisplayName(userId: string): string {
    const user = UserStore.getUser(userId);
    if (!user) return `Unknown User (${userId})`;
    return user.globalName || user.username || `User ${userId}`;
}

function getGuildIdFromChannel(channelId: string): string | undefined {
    const channel = ChannelStore.getChannel(channelId);
    if (!channel) return undefined;
    return (channel as any).guild_id ?? (channel as any).guildId ?? undefined;
}

async function muteGuildMember(guildId: string, userId: string, mute: boolean) {
    try {
        const response = await RestAPI.patch({
            url: `/guilds/${guildId}/members/${userId}`,
            body: { mute }
        });
        return response.ok !== false;
    } catch {
        return false;
    }
}

async function deafenGuildMember(guildId: string, userId: string, deaf: boolean) {
    try {
        const response = await RestAPI.patch({
            url: `/guilds/${guildId}/members/${userId}`,
            body: { deaf }
        });
        return response.ok !== false;
    } catch {
        return false;
    }
}

function joinVoiceChannel(channelId: string) {
    try {
        ChannelActions.selectVoiceChannel(channelId);
        return true;
    } catch {
        return false;
    }
}

function clearUserPermanentOperations(userId: string) {
    clearUserSettings(userId);
    if (userId === UserStore.getCurrentUser().id) {
        lastChannelIdSelf = null;
    }
}

interface UserContextProps {
    user: any;
    guildId?: string;
}

const UserContext: NavContextMenuPatchCallback = (children, { user, guildId }: UserContextProps) => {
    if (!user) return;
    if (!guildId) return;

    const isSelf = user.id === UserStore.getCurrentUser().id;
    const settings = getUserSettings(user.id);
    const usersWithOperations = getUsersWithPermanentOperations();

    const menuItems: any[] = [
        React.createElement(Menu.MenuItem, {
            id: "perm-unmute-header",
            label: "Permanent Unmute Controls",
            disabled: true
        }),
        React.createElement(Menu.MenuCheckboxItem, {
            id: "perm-unmute",
            label: "Permanent Unmute",
            checked: settings.unmute,
            action: () => {
                const newSettings = { ...settings, unmute: !settings.unmute };
                setUserSettings(user.id, newSettings);
                if (newSettings.unmute) {
                    const vs = VoiceStateStore.getVoiceStateForUser(user.id);
                    if (vs?.channelId && vs.mute) {
                        const gId = getGuildIdFromChannel(vs.channelId);
                        if (gId) void muteGuildMember(gId, user.id, false);
                    }
                }
            }
        }),
        React.createElement(Menu.MenuCheckboxItem, {
            id: "perm-undeafen",
            label: "Permanent Undeafen",
            checked: settings.undeafen,
            action: () => {
                const newSettings = { ...settings, undeafen: !settings.undeafen };
                setUserSettings(user.id, newSettings);
                if (newSettings.undeafen) {
                    const vs = VoiceStateStore.getVoiceStateForUser(user.id);
                    if (vs?.channelId && vs.deaf) {
                        const gId = getGuildIdFromChannel(vs.channelId);
                        if (gId) void deafenGuildMember(gId, user.id, false);
                    }
                }
            }
        })
    ];

    if (isSelf) {
        menuItems.push(
            React.createElement(Menu.MenuCheckboxItem, {
                id: "perm-rejoin-disconnect",
                label: "Rejoin on Disconnect",
                checked: settings.rejoinOnDisconnect,
                action: () => {
                    const newSettings = { ...settings, rejoinOnDisconnect: !settings.rejoinOnDisconnect };
                    setUserSettings(user.id, newSettings);
                    if (newSettings.rejoinOnDisconnect) {
                        const vs = VoiceStateStore.getVoiceStateForUser(user.id);
                        if (vs?.channelId) lastChannelIdSelf = vs.channelId;
                    } else {
                        lastChannelIdSelf = null;
                    }
                }
            })
        );
    }

    if (usersWithOperations.length > 0) {
        menuItems.push(
            React.createElement(Menu.MenuSeparator, { key: "perm-unmute-list-sep" }),
            React.createElement(Menu.MenuItem, {
                id: "perm-unmute-managed-users",
                label: `Permanently Unmute-Managed (${usersWithOperations.length})`,
                key: "perm-unmute-managed-header"
            }, usersWithOperations.map(({ userId, settings: s }) => {
                const displayName = getUserDisplayName(userId);
                const ops: string[] = [];
                if (s.unmute) ops.push("Unmute");
                if (s.undeafen) ops.push("Undeafen");
                if (s.rejoinOnDisconnect) ops.push("Rejoin");
                const opsText = ops.join(", ");

                return React.createElement(Menu.MenuItem, {
                    id: `perm-unmute-clear-${userId}`,
                    key: `perm-unmute-clear-${userId}`,
                    label: `${displayName} (${opsText})`,
                    action: () => clearUserPermanentOperations(userId)
                });
            }))
        );
    }

    children.splice(-1, 0,
        React.createElement(Menu.MenuGroup, {
            key: "perm-unmute-controls-group"
        }, menuItems)
    );
};

export default definePlugin({
    name: "Permanent Unmute",
    description: "Continuously unmute/undeafen against permanent mute/deafen; rejoin on disconnect for self.",
    authors: [Devs.sikilmem],

    flux: {
        VOICE_STATE_UPDATES({ voiceStates }: { voiceStates: any[]; }) {
            try {
                const selfId = UserStore.getCurrentUser().id;

                for (const { userId, channelId, oldChannelId, mute, deaf } of voiceStates) {
                    const settings = userSettings.get(userId);
                    if (!settings || (!settings.unmute && !settings.undeafen && !settings.rejoinOnDisconnect))
                        continue;

                    // Handle rejoin on disconnect for self
                    if (userId === selfId && settings.rejoinOnDisconnect) {
                        if (channelId) {
                            // User is in a channel, save it
                            lastChannelIdSelf = channelId;
                        } else if (oldChannelId && !channelId) {
                            // User disconnected (had channel before, now doesn't)
                            const channelToRejoin = lastChannelIdSelf || oldChannelId;
                            if (channelToRejoin) {
                                // Add small delay to ensure disconnect is processed
                                setTimeout(() => {
                                    joinVoiceChannel(channelToRejoin);
                                }, 500);
                            }
                        }
                    }

                    const channel = channelId ? ChannelStore.getChannel(channelId) : null;
                    const guildId = channel ? getGuildIdFromChannel(channelId!) : undefined;

                    if (!channel || !guildId) continue;

                    const canMute = PermissionStore.can(PermissionsBits.MUTE_MEMBERS, channel);
                    const canDeafen = PermissionStore.can(PermissionsBits.DEAFEN_MEMBERS, channel);

                    if (settings.unmute && canMute && mute) {
                        void muteGuildMember(guildId, userId, false);
                    }
                    if (settings.undeafen && canDeafen && deaf) {
                        void deafenGuildMember(guildId, userId, false);
                    }
                }
            } catch (e) {
                console.error("vc-permUnmute: VOICE_STATE_UPDATES error:", e);
            }
        }
    },

    contextMenus: {
        "user-context": UserContext
    }
});
