/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./notification.css";

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import type { Channel, User } from "@vencord/discord-types";
import { findByPropsLazy, findStoreLazy } from "@webpack";
import { Menu, PresenceStore, React, SelectedChannelStore, Tooltip, UserStore } from "@webpack/common";
import { CSSProperties } from "react";

import { NotificationsOffIcon } from "./components/NotificationsOffIcon";
import { NotificationsOnIcon } from "./components/NotificationsOnIcon";

const logger = new Logger("NotifyUserChanges", "#a6d189");

interface PresenceUpdate {
    user: {
        id: string;
        username?: string;
        global_name?: string;
    };
    clientStatus: {
        desktop?: string;
        web?: string;
        mobile?: string;
        console?: string;
    };
    guildId?: string;
    status: string;
    broadcast?: any; // what's this?
    activities: Array<{
        session_id: string;
        created_at: number;
        id: string;
        name: string;
        details?: string;
        type: number;
    }>;
}

interface VoiceState {
    userId: string;
    channelId?: string;
    oldChannelId?: string;
    deaf: boolean;
    mute: boolean;
    selfDeaf: boolean;
    selfMute: boolean;
    selfStream: boolean;
    selfVideo: boolean;
    sessionId: string;
    suppress: boolean;
    requestToSpeakTimestamp: string | null;
}

const SessionsStore = findStoreLazy("SessionsStore");

const StatusUtils = findByPropsLazy("useStatusFillColor", "StatusTypes");

function Icon(path: string, opts?: { viewBox?: string; width?: number; height?: number; }) {
    return ({ color, tooltip, small }: { color: string; tooltip: string; small: boolean; }) => (
        <Tooltip text={tooltip} >
            {(tooltipProps: any) => (
                <svg
                    {...tooltipProps}
                    height={(opts?.height ?? 20) - (small ? 3 : 0)}
                    width={(opts?.width ?? 20) - (small ? 3 : 0)}
                    viewBox={opts?.viewBox ?? "0 0 24 24"}
                    fill={color}
                >
                    <path d={path} />
                </svg>
            )}
        </Tooltip>
    );
}

const Icons = {
    desktop: Icon("M4 2.5c-1.103 0-2 .897-2 2v11c0 1.104.897 2 2 2h7v2H7v2h10v-2h-4v-2h7c1.103 0 2-.896 2-2v-11c0-1.103-.897-2-2-2H4Zm16 2v9H4v-9h16Z"),
    web: Icon("M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2Zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93Zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39Z"),
    mobile: Icon("M 187 0 L 813 0 C 916.277 0 1000 83.723 1000 187 L 1000 1313 C 1000 1416.277 916.277 1500 813 1500 L 187 1500 C 83.723 1500 0 1416.277 0 1313 L 0 187 C 0 83.723 83.723 0 187 0 Z M 125 1000 L 875 1000 L 875 250 L 125 250 Z M 500 1125 C 430.964 1125 375 1180.964 375 1250 C 375 1319.036 430.964 1375 500 1375 C 569.036 1375 625 1319.036 625 1250 C 625 1180.964 569.036 1125 500 1125 Z", { viewBox: "0 0 1000 1500", height: 17, width: 17 }),
    console: Icon("M14.8 2.7 9 3.1V47h3.3c1.7 0 6.2.3 10 .7l6.7.6V2l-4.2.2c-2.4.1-6.9.3-10 .5zm1.8 6.4c1 1.7-1.3 3.6-2.7 2.2C12.7 10.1 13.5 8 15 8c.5 0 1.2.5 1.6 1.1zM16 33c0 6-.4 10-1 10s-1-4-1-10 .4-10 1-10 1 4 1 10zm15-8v23.3l3.8-.7c2-.3 4.7-.6 6-.6H43V3h-2.2c-1.3 0-4-.3-6-.6L31 1.7V25z", { viewBox: "0 0 50 50" }),
};
type Platform = keyof typeof Icons;

const PlatformIcon = ({ platform, status, small }: { platform: Platform, status: string; small: boolean; }) => {
    const tooltip = platform[0].toUpperCase() + platform.slice(1);
    const Icon = Icons[platform] ?? Icons.desktop;

    return <Icon color={StatusUtils.useStatusFillColor(status)} tooltip={tooltip} small={small} />;
};

interface PlatformIndicatorProps {
    user: User;
    wantMargin?: boolean;
    wantTopMargin?: boolean;
    small?: boolean;
    style?: CSSProperties;
}

const PlatformIndicator = ({ user, wantMargin = true, wantTopMargin = false, small = false, style = {} }: PlatformIndicatorProps) => {
    if (!user || user.bot) return null;

    if (user.id === UserStore.getCurrentUser().id) {
        const sessions = SessionsStore.getSessions();
        if (typeof sessions !== "object") return null;
        const sortedSessions = Object.values(sessions).sort(({ status: a }: any, { status: b }: any) => {
            if (a === b) return 0;
            if (a === "online") return 1;
            if (b === "online") return -1;
            if (a === "idle") return 1;
            if (b === "idle") return -1;
            return 0;
        });

        const ownStatus = Object.values(sortedSessions).reduce((acc: any, curr: any) => {
            if (curr.clientInfo.client !== "unknown")
                acc[curr.clientInfo.client] = curr.status;
            return acc;
        }, {});

        const { clientStatuses } = PresenceStore.getState();
        (clientStatuses as any)[UserStore.getCurrentUser().id] = ownStatus;
    }

    const status = PresenceStore.getState()?.clientStatuses?.[user.id] as Record<Platform, string>;
    if (!status) return null;

    const icons = Object.entries(status).map(([platform, status]) => (
        <PlatformIcon
            key={platform}
            platform={platform as Platform}
            status={status}
            small={small}
        />
    ));

    if (!icons.length) return null;

    return (
        <span
            className="vc-platform-indicator"
            style={{
                display: "inline-flex",
                justifyContent: "center",
                alignItems: "center",
                marginLeft: wantMargin ? 4 : 0,
                verticalAlign: "top",
                position: "relative",
                top: wantTopMargin ? 2 : 0,
                padding: !wantMargin ? 1 : 0,
                gap: 2,
                ...style
            }}

        >
            {icons}
        </span>
    );
};

export const settings = definePluginSettings({
    notifyStatus: {
        type: OptionType.BOOLEAN,
        description: "Notify on status changes",
        restartNeeded: false,
        default: true,
    },
    notifyVoice: {
        type: OptionType.BOOLEAN,
        description: "Notify on voice channel changes",
        restartNeeded: false,
        default: false,
    },
    persistNotifications: {
        type: OptionType.BOOLEAN,
        description: "Persist notifications",
        restartNeeded: false,
        default: false,
    },
    userIds: {
        type: OptionType.STRING,
        description: "User IDs (comma separated)",
        restartNeeded: false,
        default: "",
    }
});

function getUserIdList() {
    try {
        const userIds = settings.store.userIds.split(",").filter(Boolean);
        logger.debug("getUserIdList() called, returning:", userIds);
        return userIds;
    } catch (e) {
        logger.error("Error in getUserIdList():", e);
        settings.store.userIds = "";
        return [];
    }
}

function triggerVoiceNotification(userId: string, userChannelId: string | null) {
    logger.debug("triggerVoiceNotification called", { userId, userChannelId });

    const user = UserStore.getUser(userId);
    if (!user) {
        logger.warn("User not found for userId:", userId);
        return;
    }

    const myChanId = SelectedChannelStore.getVoiceChannelId();
    const name = user.username;

    logger.debug("Voice notification details:", {
        userId,
        userName: name,
        userChannelId,
        myChanId,
        persistNotifications: settings.store.persistNotifications
    });

    if (userChannelId) {
        if (userChannelId !== myChanId) {
            logger.info("Showing notification: User joined voice channel", { userId, name, userChannelId });
            showCustomNotification({
                title: `${name} joined a voice channel`,
                body: "User joined a new voice channel",
                avatar: user.getAvatarURL(void 0, 80, true),
                duration: settings.store.persistNotifications ? 0 : 5000
            });
        } else {
            logger.debug("Skipping notification: User is in same channel as me", { userId, userChannelId, myChanId });
        }
    } else {
        logger.info("Showing notification: User left voice channel", { userId, name });
        showCustomNotification({
            title: `${name} left voice channel`,
            body: "User left their voice channel",
            avatar: user.getAvatarURL(void 0, 80, true),
            duration: settings.store.persistNotifications ? 0 : 5000
        });
    }
}

function toggleUserNotify(userId: string) {
    const userIds = getUserIdList();
    if (userIds.includes(userId)) {
        userIds.splice(userIds.indexOf(userId), 1);
    } else {
        userIds.push(userId);
    }
    settings.store.userIds = userIds.join(",");
}

interface UserContextProps {
    channel?: Channel;
    guildId?: string;
    user: User;
}

const UserContext: NavContextMenuPatchCallback = (children, { user }: UserContextProps) => {
    if (!user || user.id === UserStore.getCurrentUser().id) return;
    const isNotifyOn = getUserIdList().includes(user.id);
    const label = isNotifyOn ? "Don't notify on changes" : "Notify on changes";
    const icon = isNotifyOn ? NotificationsOffIcon : NotificationsOnIcon;

    children.splice(-1, 0, (
        <Menu.MenuGroup>
            <Menu.MenuItem
                id="toggle-notify-user"
                label={label}
                action={() => toggleUserNotify(user.id)}
                icon={icon}
            />
        </Menu.MenuGroup>
    ));
};

const lastStatuses = new Map<string, string>();

// Custom notification system
let notificationContainer: HTMLDivElement | null = null;

function getNotificationContainer(): HTMLDivElement {
    if (!notificationContainer) {
        notificationContainer = document.createElement("div");
        notificationContainer.id = "vc-notify-user-changes-notification-container";
        notificationContainer.className = "vc-notify-user-changes-notification-container";
        document.body.appendChild(notificationContainer);
        logger.debug("Created custom notification container");
    }
    return notificationContainer;
}

interface CustomNotificationOptions {
    title: string;
    body: string;
    avatar?: string;
    onClick?: () => void;
    duration?: number;
}

function showCustomNotification(options: CustomNotificationOptions) {
    const container = getNotificationContainer();
    const notificationId = `vc-notify-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    logger.debug("Showing custom notification", { notificationId, ...options });

    const notification = document.createElement("div");
    notification.className = "vc-notify-user-changes-notification";
    notification.id = notificationId;

    const duration = options.duration ?? 5000;
    let timeoutId: NodeJS.Timeout | null = null;

    const closeNotification = () => {
        if (timeoutId) clearTimeout(timeoutId);
        notification.classList.add("vc-notify-exit");
        setTimeout(() => {
            if (notification.parentElement) {
                notification.parentElement.removeChild(notification);
            }
            logger.debug("Notification closed", { notificationId });
        }, 300);
    };

    const avatarHTML = options.avatar
        ? `<div class="vc-notify-user-changes-notification-avatar"><img src="${options.avatar}" alt="" /></div>`
        : "";

    const notificationHTML = `
        ${avatarHTML}
        <div class="vc-notify-user-changes-notification-content">
            <h3 class="vc-notify-user-changes-notification-title">${options.title}</h3>
            <p class="vc-notify-user-changes-notification-body">${options.body}</p>
        </div>
        <button class="vc-notify-user-changes-notification-close" aria-label="Close">
            <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M18.4 4L12 10.4L5.6 4L4 5.6L10.4 12L4 18.4L5.6 20L12 13.6L18.4 20L20 18.4L13.6 12L20 5.6L18.4 4Z"/>
            </svg>
        </button>
    `;

    notification.innerHTML = notificationHTML;

    const closeBtn = notification.querySelector(".vc-notify-user-changes-notification-close");
    if (closeBtn) {
        closeBtn.addEventListener("click", e => {
            e.stopPropagation();
            closeNotification();
        });
    }

    if (options.onClick) {
        notification.addEventListener("click", e => {
            if (e.target !== closeBtn && !closeBtn?.contains(e.target as Node)) {
                options.onClick!();
                closeNotification();
            }
        });
    }

    container.appendChild(notification);

    if (duration > 0) {
        timeoutId = setTimeout(closeNotification, duration);
    }

    // Add hover to pause timeout
    notification.addEventListener("mouseenter", () => {
        if (timeoutId) clearTimeout(timeoutId);
    });

    notification.addEventListener("mouseleave", () => {
        if (duration > 0) {
            timeoutId = setTimeout(closeNotification, duration);
        }
    });

    logger.debug("Custom notification displayed", { notificationId });
}

export default definePlugin({
    name: "NotifyUserChanges",
    description: "Adds a notify option in the user context menu to get notified when a user changes voice channels or online status",
    authors: [Devs.sikilmem],

    settings,

    contextMenus: {
        "user-context": UserContext
    },

    start() {
        logger.info("Plugin started");
        logger.debug("Current settings:", {
            notifyStatus: settings.store.notifyStatus,
            notifyVoice: settings.store.notifyVoice,
            persistNotifications: settings.store.persistNotifications,
            userIds: settings.store.userIds,
            followedUserIds: getUserIdList()
        });
    },

    stop() {
        logger.info("Plugin stopped");
        lastStatuses.clear();
    },

    flux: {
        VOICE_STATE_UPDATES({ voiceStates }: { voiceStates: VoiceState[]; }) {
            logger.debug("VOICE_STATE_UPDATES event received", {
                voiceStatesCount: voiceStates.length,
                notifyVoice: settings.store.notifyVoice,
                userIds: settings.store.userIds
            });

            if (!settings.store.notifyVoice || !settings.store.userIds) {
                logger.debug("VOICE_STATE_UPDATES: Skipping - notifyVoice:", settings.store.notifyVoice, "userIds:", settings.store.userIds);
                return;
            }

            const followedUserIds = getUserIdList();
            logger.debug("Followed user IDs:", followedUserIds);

            for (const { userId, channelId, oldChannelId } of voiceStates) {
                logger.debug("Processing voice state update", { userId, channelId, oldChannelId });

                if (channelId !== oldChannelId) {
                    const isFollowed = followedUserIds.includes(userId);
                    logger.debug("Voice state changed", { userId, isFollowed, channelId, oldChannelId });

                    if (!isFollowed) {
                        logger.debug("Skipping: User not in followed list", { userId });
                        continue;
                    }

                    if (channelId) {
                        // move or join new channel
                        logger.info("User joined/moved to voice channel", { userId, channelId, oldChannelId });
                        triggerVoiceNotification(userId, channelId);
                    } else if (oldChannelId) {
                        // leave
                        logger.info("User left voice channel", { userId, oldChannelId });
                        triggerVoiceNotification(userId, null);
                    }
                } else {
                    logger.debug("Skipping: No channel change", { userId, channelId, oldChannelId });
                }
            }
        },
        PRESENCE_UPDATES({ updates }: { updates: PresenceUpdate[]; }) {
            logger.debug("PRESENCE_UPDATES event received", {
                updatesCount: updates.length,
                notifyStatus: settings.store.notifyStatus,
                userIds: settings.store.userIds
            });

            if (!settings.store.notifyStatus || !settings.store.userIds) {
                logger.debug("PRESENCE_UPDATES: Skipping - notifyStatus:", settings.store.notifyStatus, "userIds:", settings.store.userIds);
                return;
            }

            const followedUserIds = getUserIdList();
            logger.debug("Followed user IDs for presence:", followedUserIds);

            for (const { user: { id: userId, username }, status, clientStatus } of updates) {
                logger.debug("Processing presence update", { userId, username, status, hasClientStatus: !!clientStatus });

                const isFollowed = followedUserIds.includes(userId);
                if (!isFollowed) {
                    logger.debug("Skipping: User not in followed list", { userId });
                    continue;
                }

                const lastStatus = lastStatuses.get(userId);
                const currentStatus = status || "offline";
                logger.debug("Status comparison", { userId, currentStatus, lastStatus, statusChanged: lastStatus !== currentStatus });

                // Always show notification on first run or if status changed
                if (!lastStatuses.has(userId) || lastStatus !== currentStatus) {
                    const user = UserStore.getUser(userId);
                    if (!user) {
                        logger.warn("User not found for presence update", { userId });
                        // Still set the status even if user not found
                        lastStatuses.set(userId, currentStatus);
                        continue;
                    }

                    // Better name handling with fallbacks
                    const name = user.globalName || user.username || username || `User ${userId}`;

                    logger.info("Showing notification: User status changed", { userId, name, oldStatus: lastStatus, newStatus: currentStatus });
                    showCustomNotification({
                        title: `${name}'s status changed`,
                        body: `They are now ${currentStatus}`,
                        avatar: user.getAvatarURL(void 0, 80, true),
                        duration: settings.store.persistNotifications ? 0 : 5000
                    });
                    logger.debug("Status notification call completed");
                } else {
                    logger.debug("Skipping notification: Status unchanged", { userId, currentStatus, lastStatus });
                }
                lastStatuses.set(userId, currentStatus);
            }
        }
    },

});
