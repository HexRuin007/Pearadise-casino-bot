import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    Client,
    EmbedBuilder,
    GatewayIntentBits
} from "discord.js";

const {
    DISCORD_BOT_TOKEN,
    DISCORD_CHANNEL_ID,
    DISCORD_APPROVER_ROLE_IDS = "",
    DISCORD_BOT_SECRET,
    CASINO_BACKEND_URL,
    POLL_INTERVAL_SECONDS = "15"
} = process.env;

for (const [name, value] of Object.entries({
    DISCORD_BOT_TOKEN,
    DISCORD_CHANNEL_ID,
    DISCORD_BOT_SECRET,
    CASINO_BACKEND_URL
})) {
    if (!value) {
        throw new Error(
            `Missing environment variable: ${name}`
        );
    }
}

const backendUrl =
    CASINO_BACKEND_URL.replace(/\/+$/, "");

const approverRoleIds = new Set(
    DISCORD_APPROVER_ROLE_IDS
        .split(",")
        .map(value => value.trim())
        .filter(Boolean)
);

const client = new Client({
    intents: [GatewayIntentBits.Guilds]
});

const postedRequests = new Map();

function formatChips(value) {
    const n = Number(value || 0);
    const abs = Math.abs(n);

    const format = (divisor, suffix) =>
        `${(n / divisor)
            .toFixed(2)
            .replace(/\.?0+$/, "")}${suffix}`;

    if (abs >= 1e15) return format(1e15, "Q");
    if (abs >= 1e12) return format(1e12, "T");
    if (abs >= 1e9) return format(1e9, "B");
    if (abs >= 1e6) return format(1e6, "M");
    if (abs >= 1e3) return format(1e3, "K");

    return Math.floor(n).toLocaleString("en-GB");
}

async function backendRequest(
    endpoint,
    {
        method = "GET",
        body
    } = {}
) {
    const response = await fetch(
        `${backendUrl}${endpoint}`,
        {
            method,
            headers: {
                "Content-Type": "application/json",
                "X-Discord-Bot-Secret":
                    DISCORD_BOT_SECRET
            },
            body:
                body === undefined
                    ? undefined
                    : JSON.stringify(body)
        }
    );

    const data = await response.json().catch(
        () => ({
            ok: false,
            error: `HTTP ${response.status}`
        })
    );

    if (!response.ok || !data.ok) {
        throw new Error(
            data.error ||
            `Backend request failed (${response.status})`
        );
    }

    return data;
}

function canApprove(interaction) {
    if (!interaction.inGuild()) return false;

    if (approverRoleIds.size === 0) {
        return Boolean(
            interaction.memberPermissions?.has(
                "Administrator"
            )
        );
    }

    const roles =
        interaction.member?.roles?.cache;

    if (!roles) return false;

    return [...approverRoleIds].some(
        roleId => roles.has(roleId)
    );
}

function requestMessage(request) {
    const embed = new EmbedBuilder()
        .setColor(0xf1c40f)
        .setTitle("New Casino Chip Request")
        .addFields(
            {
                name: "Player",
                value:
                    `${request.playerName}\n` +
                    `User ID: \`${request.playerId}\``,
                inline: true
            },
            {
                name: "Requested",
                value:
                    `**${formatChips(
                        request.amount
                    )} chips**`,
                inline: true
            },
            {
                name: "Current Balance",
                value:
                    `${formatChips(
                        request.currentBalance
                    )} chips`,
                inline: true
            }
        )
        .setFooter({
            text:
                `Request ID: ${request.requestId}`
        })
        .setTimestamp(
            new Date(
                request.updatedAt ||
                request.createdAt ||
                Date.now()
            )
        );

    const row =
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(
                    `chips:approve:${request.requestId}`
                )
                .setLabel("Approve")
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(
                    `chips:deny:${request.requestId}`
                )
                .setLabel("Deny")
                .setStyle(ButtonStyle.Danger)
        );

    return {
        embeds: [embed],
        components: [row]
    };
}

async function syncRequests() {
    const channel = await client.channels.fetch(
        DISCORD_CHANNEL_ID
    );

    if (
        !channel ||
        !channel.isTextBased()
    ) {
        throw new Error(
            "DISCORD_CHANNEL_ID is not a text channel"
        );
    }

    const data = await backendRequest(
        "/discord/chips/requests"
    );

    for (const request of data.requests) {
        if (
            postedRequests.has(
                request.requestId
            )
        ) {
            continue;
        }

        const message = await channel.send(
            requestMessage(request)
        );

        postedRequests.set(
            request.requestId,
            message.id
        );
    }
}

client.once("ready", async () => {
    console.log(
        `Logged in as ${client.user.tag}`
    );

    await syncRequests().catch(console.error);

    setInterval(
        () => syncRequests().catch(console.error),
        Math.max(
            10,
            Number(POLL_INTERVAL_SECONDS) || 15
        ) * 1000
    );
});

client.on(
    "interactionCreate",
    async interaction => {
        if (!interaction.isButton()) return;

        const match =
            interaction.customId.match(
                /^chips:(approve|deny):([a-f0-9]+)$/
            );

        if (!match) return;

        if (!canApprove(interaction)) {
            await interaction.reply({
                content:
                    "You do not have permission to handle chip requests.",
                ephemeral: true
            });
            return;
        }

        const [, action, requestId] = match;

        await interaction.deferUpdate();

        try {
            const result = await backendRequest(
                action === "approve"
                    ? "/discord/chips/approve"
                    : "/discord/chips/deny",
                {
                    method: "POST",
                    body: {
                        requestId,
                        discordUserId:
                            interaction.user.id,
                        discordDisplayName:
                            interaction.user.tag
                    }
                }
            );

            const embed =
                EmbedBuilder.from(
                    interaction.message.embeds[0]
                )
                    .setColor(
                        action === "approve"
                            ? 0x2ecc71
                            : 0xe74c3c
                    )
                    .setTitle(
                        action === "approve"
                            ? "Chip Request Approved"
                            : "Chip Request Denied"
                    )
                    .addFields({
                        name: "Handled By",
                        value:
                            `${interaction.user.tag}\n` +
                            `<@${interaction.user.id}>`,
                        inline: false
                    });

            if (
                action === "approve" &&
                result.newBalance !== undefined
            ) {
                embed.addFields({
                    name: "New Balance",
                    value:
                        `${formatChips(
                            result.newBalance
                        )} chips`,
                    inline: false
                });
            }

            await interaction.message.edit({
                embeds: [embed],
                components: []
            });

            postedRequests.delete(requestId);
        } catch (error) {
            console.error(error);

            await interaction.followUp({
                content:
                    `Could not ${action} request: ` +
                    error.message,
                ephemeral: true
            });
        }
    }
);

client.login(DISCORD_BOT_TOKEN);
