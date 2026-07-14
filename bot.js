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
let syncRunning = false;

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
                    `chips:approve-paid:${request.requestId}`
                )
                .setLabel("Approve Paid")
                .setEmoji("💷")
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(
                    `chips:approve-free:${request.requestId}`
                )
                .setLabel("Approve Free")
                .setEmoji("🎁")
                .setStyle(ButtonStyle.Primary),
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

function withdrawalGrantBreakdown(event) {
    if (!event.bankerGrantedSinceLastWithdrawal) {
        return event.hadPreviousWithdrawalRequest
            ? "❌ No banker grants since the previous withdrawal request"
            : "ℹ️ No previous withdrawal request found; no banker grants recorded in the available history";
    }

    const lines = [];

    const paidAmount = Number(
        event.paidBankerGrantAmountSinceLastWithdrawal || 0
    );
    const freeAmount = Number(
        event.freeBankerGrantAmountSinceLastWithdrawal || 0
    );
    const unclassifiedAmount = Number(
        event.unclassifiedBankerGrantAmountSinceLastWithdrawal || 0
    );

    const paidCount = Number(
        event.paidBankerGrantCountSinceLastWithdrawal || 0
    );
    const freeCount = Number(
        event.freeBankerGrantCountSinceLastWithdrawal || 0
    );
    const unclassifiedCount = Number(
        event.unclassifiedBankerGrantCountSinceLastWithdrawal || 0
    );

    if (paidAmount > 0 || paidCount > 0) {
        lines.push(
            `💷 **Paid:** ${formatChips(paidAmount)} chips ` +
            `across ${paidCount} grant(s)`
        );
    }

    if (freeAmount > 0 || freeCount > 0) {
        lines.push(
            `🎁 **Free:** ${formatChips(freeAmount)} chips ` +
            `across ${freeCount} grant(s)`
        );
    }

    if (unclassifiedAmount > 0 || unclassifiedCount > 0) {
        lines.push(
            `ℹ️ **Older/unclassified:** ` +
            `${formatChips(unclassifiedAmount)} chips ` +
            `across ${unclassifiedCount} grant(s)`
        );
    }

    if (lines.length === 0) {
        lines.push(
            `✅ Banker grants found: ` +
            `${formatChips(event.bankerGrantAmountSinceLastWithdrawal)} chips ` +
            `across ${event.bankerGrantCountSinceLastWithdrawal || 1} grant(s)`
        );
    }

    const classificationLabels = {
        paid: "Paid only",
        free: "Free only",
        mixed: "Mixed paid and free",
        unclassified: "Older unclassified grants",
        none: "No banker grants"
    };

    lines.unshift(
        `**Classification:** ${
            classificationLabels[event.bankerGrantClassification] ||
            "Banker grants recorded"
        }`
    );

    return lines.join("\n");
}

function auditEventMessage(event) {
    if (event.type === "banker-grant") {
        const sourceLabels = {
            "manual-grant": "Manual banker grant",
            "approved-request": "Approved in userapp",
            "discord-approved-request": "Approved through Discord"
        };

        return {
            embeds: [
                new EmbedBuilder()
                    .setColor(0x2ecc71)
                    .setTitle("Casino Chips Given")
                    .addFields(
                        {
                            name: "Player",
                            value:
                                `${event.playerName || "Player"}\n` +
                                `User ID: \`${event.playerId}\``,
                            inline: true
                        },
                        {
                            name: "Amount Given",
                            value:
                                `**${formatChips(event.amount)} chips**`,
                            inline: true
                        },
                        {
                            name: "New Balance",
                            value:
                                `${formatChips(event.newBalance)} chips`,
                            inline: true
                        },
                        {
                            name: "Grant Type",
                            value:
                                event.grantType === "free"
                                    ? "🎁 **Free chips** — the player did not pay"
                                    : event.grantType === "paid"
                                        ? "💷 **Paid chips** — the player paid for these chips"
                                        : "ℹ️ **Unclassified** — older grant without a saved type",
                            inline: false
                        },
                        {
                            name: "Source",
                            value:
                                sourceLabels[event.source] ||
                                event.source ||
                                "Banker grant",
                            inline: false
                        }
                    )
                    .setFooter({
                        text: `Event ID: ${event.eventId}`
                    })
                    .setTimestamp(
                        new Date(event.createdAt || Date.now())
                    )
            ]
        };
    }

    if (event.type === "daily-spin-item") {
        const row =
            new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(
                        `dailyspin:delivered:${event.deliveryId}`
                    )
                    .setLabel("Mark Delivered")
                    .setEmoji("✅")
                    .setStyle(ButtonStyle.Success)
            );

        return {
            embeds: [
                new EmbedBuilder()
                    .setColor(0x9b59b6)
                    .setTitle("Daily Spin Item Won")
                    .addFields(
                        {
                            name: "Player",
                            value:
                                `${event.playerName || "Player"}\n` +
                                `User ID: \`${event.playerId}\``,
                            inline: true
                        },
                        {
                            name: "Prize",
                            value:
                                `**${event.quantity || 1}x ${event.itemName || event.prizeLabel}**`,
                            inline: true
                        },
                        {
                            name: "Status",
                            value: "Pending in-game delivery",
                            inline: false
                        }
                    )
                    .setFooter({
                        text: `Delivery ID: ${event.deliveryId}`
                    })
                    .setTimestamp(new Date(event.createdAt || Date.now()))
            ],
            components: [row]
        };
    }

    if (event.type === "player-reset") {
        return {
            embeds: [
                new EmbedBuilder()
                    .setColor(0xe74c3c)
                    .setTitle("Casino Player Reset")
                    .addFields(
                        {
                            name: "Player Reset",
                            value:
                                `${event.playerName || "Player"}\n` +
                                `User ID: \`${event.playerId}\``,
                            inline: true
                        },
                        {
                            name: "Previous Balance",
                            value:
                                `**${formatChips(event.previousBalance)} chips**`,
                            inline: true
                        },
                        {
                            name: "Reset By",
                            value:
                                `${event.resetByName || "Banker"}\n` +
                                `User ID: \`${event.resetById || "Unknown"}\``,
                            inline: true
                        },
                        {
                            name: "Result",
                            value:
                                "The player's casino balance, statistics, requests, active games and eligible rewards were cleared.",
                            inline: false
                        }
                    )
                    .setFooter({
                        text: `Event ID: ${event.eventId}`
                    })
                    .setTimestamp(
                        new Date(event.createdAt || Date.now())
                    )
            ]
        };
    }

    if (event.type === "withdrawal-request") {
        const row =
            new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(
                        `withdrawal:complete:${event.withdrawalRequestId}`
                    )
                    .setLabel("Completed")
                    .setEmoji("✅")
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId(
                        `withdrawal:deny:${event.withdrawalRequestId}`
                    )
                    .setLabel("Deny")
                    .setStyle(ButtonStyle.Danger)
            );

        return {
            embeds: [
                new EmbedBuilder()
                    .setColor(0xe67e22)
                    .setTitle(
                        event.updated
                            ? "Chip Withdrawal Request Updated"
                            : "New Chip Withdrawal Request"
                    )
                    .addFields(
                        {
                            name: "Player",
                            value:
                                `${event.playerName || "Player"}\n` +
                                `User ID: \`${event.playerId}\``,
                            inline: true
                        },
                        {
                            name: "Wants to Withdraw",
                            value:
                                `**${formatChips(event.amount)} chips**`,
                            inline: true
                        },
                        {
                            name: "Current Balance",
                            value:
                                `${formatChips(event.currentBalance)} chips`,
                            inline: true
                        },
                        {
                            name: "Banker Chips Since Last Withdrawal Request",
                            value:
                                withdrawalGrantBreakdown(event),
                            inline: false
                        }
                    )
                    .setFooter({
                        text:
                            `Withdrawal ID: ${event.withdrawalRequestId}`
                    })
                    .setTimestamp(
                        new Date(event.createdAt || Date.now())
                    )
            ],
            components: [row]
        };
    }

    if (event.type === "withdrawal-completed") {
        return {
            embeds: [
                new EmbedBuilder()
                    .setColor(0x3498db)
                    .setTitle("Chip Withdrawal Completed")
                    .addFields(
                        {
                            name: "Player",
                            value:
                                `${event.playerName || "Player"}\n` +
                                `User ID: \`${event.playerId}\``,
                            inline: true
                        },
                        {
                            name: "Chips Removed",
                            value:
                                `**${formatChips(event.amount)} chips**`,
                            inline: true
                        },
                        {
                            name: "New Balance",
                            value:
                                `${formatChips(event.newBalance)} chips`,
                            inline: true
                        }
                    )
                    .setTimestamp(
                        new Date(event.createdAt || Date.now())
                    )
            ]
        };
    }

    return null;
}

async function getChannel() {
    const channel = await client.channels.fetch(
        DISCORD_CHANNEL_ID
    );

    if (!channel || !channel.isTextBased()) {
        throw new Error(
            "DISCORD_CHANNEL_ID is not a text channel"
        );
    }

    return channel;
}

async function syncRequests(channel) {
    const data = await backendRequest(
        "/discord/chips/requests"
    );

    for (const request of data.requests) {
        if (postedRequests.has(request.requestId)) {
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

async function syncAuditEvents(channel) {
    const data = await backendRequest(
        "/discord/chips/events"
    );

    for (const event of data.events || []) {
        const payload = auditEventMessage(event);

        if (!payload) {
            await backendRequest(
                "/discord/chips/event-ack",
                {
                    method: "POST",
                    body: { eventId: event.eventId }
                }
            );
            continue;
        }

        const message = await channel.send(payload);

        await backendRequest(
            "/discord/chips/event-ack",
            {
                method: "POST",
                body: {
                    eventId: event.eventId,
                    discordMessageId: message.id
                }
            }
        );
    }
}

async function syncAll() {
    if (syncRunning) return;
    syncRunning = true;

    try {
        const channel = await getChannel();
        await syncRequests(channel);
        await syncAuditEvents(channel);
    } finally {
        syncRunning = false;
    }
}

client.once("ready", async () => {
    console.log(
        `Logged in as ${client.user.tag}`
    );

    await syncAll().catch(console.error);

    setInterval(
        () => syncAll().catch(console.error),
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

        const chipMatch =
            interaction.customId.match(
                /^chips:(approve-paid|approve-free|deny):([a-f0-9]+)$/
            );

        const withdrawalMatch =
            interaction.customId.match(
                /^withdrawal:(complete|deny):([a-f0-9]+)$/
            );

        const dailySpinMatch =
            interaction.customId.match(
                /^dailyspin:delivered:([a-f0-9]+)$/
            );

        if (!chipMatch && !withdrawalMatch && !dailySpinMatch) {
            return;
        }

        if (!canApprove(interaction)) {
            await interaction.reply({
                content:
                    "You do not have permission to handle casino requests.",
                ephemeral: true
            });
            return;
        }

        await interaction.deferUpdate();

        if (dailySpinMatch) {
            const [, deliveryId] = dailySpinMatch;

            try {
                const result = await backendRequest(
                    "/discord/daily-spin/delivered",
                    {
                        method: "POST",
                        body: {
                            deliveryId,
                            discordUserId: interaction.user.id,
                            discordDisplayName: interaction.user.tag
                        }
                    }
                );

                const embed =
                    EmbedBuilder.from(
                        interaction.message.embeds[0]
                    )
                        .setColor(0x2ecc71)
                        .setTitle("Daily Spin Prize Delivered")
                        .spliceFields(2, 1, {
                            name: "Status",
                            value: "✅ Delivered in game",
                            inline: false
                        })
                        .addFields({
                            name: "Delivered By",
                            value:
                                `${interaction.user.tag}\n` +
                                `<@${interaction.user.id}>`,
                            inline: false
                        })
                        .setTimestamp(
                            new Date(
                                result.delivery?.deliveredAt || Date.now()
                            )
                        );

                await interaction.message.edit({
                    embeds: [embed],
                    components: []
                });
            } catch (error) {
                console.error(error);

                await interaction.followUp({
                    content:
                        "Could not mark the daily-spin prize as delivered: " +
                        error.message,
                    ephemeral: true
                });
            }

            return;
        }

        if (withdrawalMatch) {
            const [, action, withdrawalRequestId] =
                withdrawalMatch;

            try {
                const result = await backendRequest(
                    action === "complete"
                        ? "/discord/chips/withdrawal-complete"
                        : "/discord/chips/withdrawal-deny",
                    {
                        method: "POST",
                        body: {
                            withdrawalRequestId,
                            discordUserId:
                                interaction.user.id,
                            discordDisplayName:
                                interaction.user.tag
                        }
                    }
                );

                const completed =
                    action === "complete";

                const embed =
                    EmbedBuilder.from(
                        interaction.message.embeds[0]
                    )
                        .setColor(
                            completed
                                ? 0x2ecc71
                                : 0xe74c3c
                        )
                        .setTitle(
                            completed
                                ? "Withdrawal Completed"
                                : "Withdrawal Denied"
                        )
                        .addFields({
                            name: "Handled By",
                            value:
                                `${interaction.user.tag}\n` +
                                `<@${interaction.user.id}>`,
                            inline: false
                        });

                if (completed) {
                    embed.addFields(
                        {
                            name: "Chips Removed",
                            value:
                                `**${formatChips(
                                    result.amountRemoved
                                )} chips**`,
                            inline: true
                        },
                        {
                            name: "Remaining Balance",
                            value:
                                `${formatChips(
                                    result.newBalance
                                )} chips`,
                            inline: true
                        }
                    );
                } else {
                    embed.addFields({
                        name: "Decision",
                        value:
                            "No chips were removed from the player's balance.",
                        inline: false
                    });
                }

                await interaction.message.edit({
                    embeds: [embed],
                    components: []
                });
            } catch (error) {
                console.error(error);

                await interaction.followUp({
                    content:
                        `Could not ${action} withdrawal: ` +
                        error.message,
                    ephemeral: true
                });
            }

            return;
        }

        const [, action, requestId] = chipMatch;

        const approving = action !== "deny";
        const grantType =
            action === "approve-free"
                ? "free"
                : "paid";

        try {
            const result = await backendRequest(
                approving
                    ? "/discord/chips/approve"
                    : "/discord/chips/deny",
                {
                    method: "POST",
                    body: {
                        requestId,
                        grantType: approving
                            ? grantType
                            : undefined,
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
                        approving
                            ? grantType === "free"
                                ? 0x3498db
                                : 0x2ecc71
                            : 0xe74c3c
                    )
                    .setTitle(
                        approving
                            ? grantType === "free"
                                ? "Chip Request Approved as Free"
                                : "Chip Request Approved as Paid"
                            : "Chip Request Denied"
                    )
                    .addFields({
                        name: "Handled By",
                        value:
                            `${interaction.user.tag}\n` +
                            `<@${interaction.user.id}>`,
                        inline: false
                    });

            if (approving) {
                embed.addFields({
                    name: "Grant Type",
                    value:
                        grantType === "free"
                            ? "🎁 Free chips — the player did not pay"
                            : "💷 Paid chips — the player paid for these chips",
                    inline: false
                });
            }

            if (
                approving &&
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

            await syncAll().catch(console.error);
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
