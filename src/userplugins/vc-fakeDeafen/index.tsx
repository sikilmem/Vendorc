/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";
import { findByProps, findComponentByCodeLazy } from "@webpack";
import { React } from "@webpack/common";

let originalVoiceStateUpdate: any;
let fakeDeafenEnabled = false;

const Button = findComponentByCodeLazy(".GREEN,positionKeyStemOverride:");

function FakeDeafenIcon({ enabled }: { enabled: boolean; }) {
    const color = enabled ? "#fff" : "#888";
    return (
        <svg width="20" height="20" viewBox="0 0 32 32" fill="none" style={{ width: "20px", height: "20px" }}>
            <rect x="6" y="8" width="20" height="4" rx="2" fill={color} />
            <rect x="11" y="3" width="10" height="8" rx="3" fill={color} />
            <circle cx="10" cy="21" r="4" stroke={color} strokeWidth="2" fill="none" />
            <circle cx="22" cy="21" r="4" stroke={color} strokeWidth="2" fill="none" />
            <path d="M14 21c1 1 3 1 4 0" stroke={color} strokeWidth="2" strokeLinecap="round" />
        </svg>
    );
}

function FakeDeafenButton(props: { nameplate?: any; }) {
    const [enabled, setEnabled] = React.useState(fakeDeafenEnabled);

    const handleClick = React.useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();

        const newState = !fakeDeafenEnabled;
        fakeDeafenEnabled = newState;
        setEnabled(newState);

        const ChannelStore = findByProps("getChannel", "getDMFromUserId");
        const SelectedChannelStore = findByProps("getVoiceChannelId");
        const GatewayConnection = findByProps("voiceStateUpdate", "voiceServerPing");
        const MediaEngineStore = findByProps("isDeaf", "isMute");

        if (!GatewayConnection || !SelectedChannelStore) return;

        const channelId = SelectedChannelStore.getVoiceChannelId();
        const channel = channelId ? ChannelStore?.getChannel(channelId) : null;

        if (channel) {
            GatewayConnection.voiceStateUpdate({
                channelId: channel.id,
                guildId: channel.guild_id,
                selfMute: newState || (MediaEngineStore?.isMute() ?? false),
                selfDeaf: newState || (MediaEngineStore?.isDeaf() ?? false)
            });
        }
    }, []);

    return (
        <Button
            tooltipText={enabled ? "Disable Fake Deafen" : "Enable Fake Deafen"}
            icon={() => <FakeDeafenIcon enabled={enabled} />}
            role="switch"
            aria-checked={enabled}
            redGlow={enabled}
            plated={props?.nameplate != null}
            onClick={handleClick}
        />
    );
}

export default definePlugin({
    name: "FakeDeafen",
    description: "Fake deafen yourself.",
    authors: [Devs.sikilmem],
    patches: [
        {
            find: "#{intl::ACCOUNT_SPEAKING_WHILE_MUTED}",
            replacement: {
                match: /children:\[(?=.{0,25}?accountContainerRef)/,
                replace: "children:[$self.FakeDeafenButton(arguments[0]),"
            }
        }
    ],
    FakeDeafenButton: ErrorBoundary.wrap(FakeDeafenButton, { noop: true }),
    start() {
        const GatewayConnection = findByProps("voiceStateUpdate", "voiceServerPing");
        if (!GatewayConnection) return;

        originalVoiceStateUpdate = GatewayConnection.voiceStateUpdate;
        GatewayConnection.voiceStateUpdate = function (args: any) {
            if (fakeDeafenEnabled && args && typeof args === "object") {
                args.selfMute = true;
                args.selfDeaf = true;
            }
            return originalVoiceStateUpdate.apply(this, arguments);
        };
    },
    stop() {
        const GatewayConnection = findByProps("voiceStateUpdate", "voiceServerPing");
        if (GatewayConnection && originalVoiceStateUpdate) {
            GatewayConnection.voiceStateUpdate = originalVoiceStateUpdate;
        }
    }
});
