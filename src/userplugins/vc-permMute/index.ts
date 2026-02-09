/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";
import { ChannelStore, Menu, PermissionsBits, PermissionStore, React, RestAPI, UserStore, VoiceStateStore } from "@webpack/common";

interface UserSettings {
    mute: boolean;
    deaf: boolean;
    disconnect: boolean;
}

const userSettings = new Map<string, UserSettings>();

function getUserSettings(userId: string): UserSettings {
    if (!userSettings.has(userId)) {
        userSettings.set(userId, { mute: false, deaf: false, disconnect: false });
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
        if (settings.mute || settings.deaf || settings.disconnect) {
            users.push({ userId, settings });
        }
    }
    return users;
}

async function clearUserPermanentOperations(userId: string, guildId?: string) {
    const settings = userSettings.get(userId);
    if (!settings) return;

    // If user is in a voice channel, undo mute/deafen before clearing
    const voiceState = VoiceStateStore.getVoiceStateForUser(userId);
    if (voiceState?.channelId) {
        const channelGuildId = getGuildIdFromChannel(voiceState.channelId);
        if (channelGuildId) {
            if (settings.mute) {
                await muteGuildMember(channelGuildId, userId, false);
            }
            if (settings.deaf) {
                await deafenGuildMember(channelGuildId, userId, false);
            }
        }
    } else if (guildId) {
        // User not in voice, but try with the current guild
        if (settings.mute) {
            await muteGuildMember(guildId, userId, false);
        }
        if (settings.deaf) {
            await deafenGuildMember(guildId, userId, false);
        }
    }

    clearUserSettings(userId);
}

function getUserDisplayName(userId: string): string {
    const user = UserStore.getUser(userId);
    if (!user) return `Unknown User (${userId})`;
    return user.globalName || user.username || `User ${userId}`;
}

async function disconnectGuildMember(guildId: string, userId: string) {
    try {
        const response = await RestAPI.patch({
            url: `/guilds/${guildId}/members/${userId}`,
            body: { channel_id: null }
        });
        return response.ok !== false;
    } catch {
        return false;
    }
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

function getGuildIdFromChannel(channelId: string): string | undefined {
    const channel = ChannelStore.getChannel(channelId);
    if (!channel) return undefined;
    return (channel as any).guild_id ?? (channel as any).guildId ?? undefined;
}

interface UserContextProps {
    user: any;
    guildId?: string;
}

const UserContext: NavContextMenuPatchCallback = (children, { user, guildId }: UserContextProps) => {
    if (!user || user.id === UserStore.getCurrentUser().id) return;
    if (!guildId) return; // Only work in guilds

    const settings = getUserSettings(user.id);
    const usersWithOperations = getUsersWithPermanentOperations();

    const menuItems: any[] = [
        React.createElement(Menu.MenuItem, {
            id: "perm-voice-controls-header",
            label: "Permanent Voice Controls",
            disabled: true
        }),
        React.createElement(Menu.MenuCheckboxItem, {
            id: "perm-mute",
            label: "Permanent Mute",
            checked: settings.mute,
            action: () => {
                const newSettings = { ...settings, mute: !settings.mute };
                setUserSettings(user.id, newSettings);
                if (newSettings.mute) {
                    const channel = VoiceStateStore.getVoiceStateForUser(user.id)?.channelId;
                    if (channel) {
                        const gId = getGuildIdFromChannel(channel);
                        if (gId) void muteGuildMember(gId, user.id, true);
                    }
                } else if (guildId) {
                    void muteGuildMember(guildId, user.id, false);
                }
            }
        }),
        React.createElement(Menu.MenuCheckboxItem, {
            id: "perm-deaf",
            label: "Permanent Deaf",
            checked: settings.deaf,
            action: () => {
                const newSettings = { ...settings, deaf: !settings.deaf };
                setUserSettings(user.id, newSettings);
                if (newSettings.deaf) {
                    const channel = VoiceStateStore.getVoiceStateForUser(user.id)?.channelId;
                    if (channel) {
                        const gId = getGuildIdFromChannel(channel);
                        if (gId) void deafenGuildMember(gId, user.id, true);
                    }
                } else if (guildId) {
                    void deafenGuildMember(guildId, user.id, false);
                }
            }
        }),
        React.createElement(Menu.MenuCheckboxItem, {
            id: "perm-disconnect",
            label: "Permanent Disconnect",
            checked: settings.disconnect,
            action: () => {
                const newSettings = { ...settings, disconnect: !settings.disconnect };
                setUserSettings(user.id, newSettings);
                if (newSettings.disconnect) {
                    const channel = VoiceStateStore.getVoiceStateForUser(user.id)?.channelId;
                    if (channel) {
                        const gId = getGuildIdFromChannel(channel);
                        if (gId) void disconnectGuildMember(gId, user.id);
                    }
                }
            }
        })
    ];

    // Add list of users with permanent operations
    if (usersWithOperations.length > 0) {
        menuItems.push(
            React.createElement(Menu.MenuSeparator, { key: "perm-list-separator" }),
            React.createElement(Menu.MenuItem, {
                id: "perm-managed-users",
                label: `Permanently Managed Users (${usersWithOperations.length})`,
                key: "perm-managed-users-header"
            }, usersWithOperations.map(({ userId, settings: userPermSettings }) => {
                const displayName = getUserDisplayName(userId);
                const operations: string[] = [];
                if (userPermSettings.mute) operations.push("Mute");
                if (userPermSettings.deaf) operations.push("Deaf");
                if (userPermSettings.disconnect) operations.push("Disconnect");
                const operationsText = operations.join(", ");

                return React.createElement(Menu.MenuItem, {
                    id: `perm-clear-${userId}`,
                    key: `perm-clear-${userId}`,
                    label: `${displayName} (${operationsText})`,
                    action: () => {
                        void clearUserPermanentOperations(userId, guildId);
                    }
                });
            }))
        );
    }

    children.splice(-1, 0,
        React.createElement(Menu.MenuGroup, {
            key: "perm-voice-controls-group"
        }, menuItems)
    );
};

export default definePlugin({
    name: "Permanent Voice Controls",
    description: "Adds persistent mute, deaf, and disconnect controls to user context menu",
    authors: [Devs.sikilmem],

    flux: {
        VOICE_STATE_UPDATES({ voiceStates }: { voiceStates: any[]; }) {
            try {
                for (const { userId, channelId, mute, deaf } of voiceStates) {
                    const settings = userSettings.get(userId);
                    if (!settings || (!settings.disconnect && !settings.mute && !settings.deaf)) continue;

                    const channel = channelId ? ChannelStore.getChannel(channelId) : null;
                    if (!channel) continue;
                    const guildId = getGuildIdFromChannel(channelId!);
                    if (!guildId) continue;

                    // Check permissions
                    const canMove = PermissionStore.can(PermissionsBits.MOVE_MEMBERS, channel);
                    const canMute = PermissionStore.can(PermissionsBits.MUTE_MEMBERS, channel);
                    const canDeafen = PermissionStore.can(PermissionsBits.DEAFEN_MEMBERS, channel);

                    if (settings.disconnect && channelId && canMove) {
                        // User joined a voice channel, disconnect them
                        void disconnectGuildMember(guildId, userId);
                    }

                    // Continuously apply mute/deafen based on current voice state
                    if (settings.mute && canMute && !mute) {
                        void muteGuildMember(guildId, userId, true);
                    }
                    if (settings.deaf && canDeafen && !deaf) {
                        void deafenGuildMember(guildId, userId, true);
                    }
                }
            } catch (e) {
                console.error("vc-permMute: Error in VOICE_STATE_UPDATES:", e);
            }
        },
    },

    contextMenus: {
        "user-context": UserContext
    }
});
