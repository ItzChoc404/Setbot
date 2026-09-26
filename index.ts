import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
  Events,
  ForumChannel,
  GatewayIntentBits,
  Interaction,
  REST,
  Routes,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  ThreadChannel,
  type APIEmbedField,
  type TextChannel,
} from 'discord.js';

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

if (!TOKEN || !CLIENT_ID) throw new Error('Missing DISCORD_TOKEN or CLIENT_ID');

const API_BASE = 'https://api.tcgdex.net/v2';
const LANGUAGE_LABELS: Record<string, string> = {
  en: 'English',
  'zh-tw': 'Chinese',
  ja: 'Japanese',
};

type TcgLanguage = keyof typeof LANGUAGE_LABELS;
type SortKey = 'name' | 'number' | 'rarity';
type SortOrder = 'asc' | 'desc';

interface SetBrief {
  id: string;
  name: string;
  logo?: string;
  symbol?: string;
  cardCount?: { total?: number; official?: number };
}

interface SetData extends SetBrief {
  releaseDate?: string;
  serie?: { id: string; name: string };
  cards?: Array<{ id: string; localId: string | number; name: string; image?: string }>;
}

interface CardData {
  id: string;
  localId: string | number;
  name: string;
  image?: string;
  rarity?: string;
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function tcgdex<T>(lang: TcgLanguage, path: string): Promise<T> {
  const url = `${API_BASE}/${lang}/${path.replace(/^\//, '')}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(url, { headers: { 'User-Agent': 'PokeMarket-QuickSet/1.0' } });
    if (response.ok) return (await response.json()) as T;
    if (response.status === 429 || response.status >= 500) {
      await sleep(1000 * (attempt + 1));
      continue;
    }
    const body = await response.text();
    throw new Error(`TCGdex ${response.status}: ${body.slice(0, 300)}`);
  }
  throw new Error(`TCGdex request failed after retries: ${path}`);
}

async function getSets(lang: TcgLanguage): Promise<SetBrief[]> {
  // TCGdex's default set ordering is releaseDate > localId > id, but we ask explicitly
  // for releaseDate ASC so QuickSet always starts with the oldest sets.
  return tcgdex<SetBrief[]>(lang, 'sets?sort:field=releaseDate&sort:order=ASC');
}

async function getSet(lang: TcgLanguage, id: string): Promise<SetData> {
  return tcgdex<SetData>(lang, `sets/${encodeURIComponent(id)}`);
}

async function getCard(lang: TcgLanguage, id: string): Promise<CardData> {
  return tcgdex<CardData>(lang, `cards/${encodeURIComponent(id)}`);
}

function languageSelect(customId: string) {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder('Choose a language')
      .addOptions(
        { label: 'English', value: 'en', emoji: '🇬🇧' },
        { label: 'Chinese', value: 'zh-tw', emoji: '🇨🇳' },
        { label: 'Japanese', value: 'ja', emoji: '🇯🇵' },
      ),
  );
}

function forumSelect(customId: string) {
  return new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder('Choose the forum to post the sets in')
      .setChannelTypes(ChannelType.GuildForum),
  );
}

function sortSelect(customId: string) {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder('Choose how to sort the cards')
      .addOptions(
        { label: 'A–Z ascending', value: 'name:asc' },
        { label: 'Z–A descending', value: 'name:desc' },
        { label: 'Card number ascending', value: 'number:asc' },
        { label: 'Card number descending', value: 'number:desc' },
        { label: 'Rarity ascending', value: 'rarity:asc' },
        { label: 'Rarity descending', value: 'rarity:desc' },
      ),
  );
}

function setMarker(id: string) {
  return `TCGDEX_SET:${id}`;
}

function threadName(index: number, set: SetData) {
  const prefix = `${String(index + 1).padStart(3, '0')} • `;
  const marker = ` [TCGDEX:${set.id}]`;
  const max = 100 - marker.length;
  return `${prefix}${set.name}`.slice(0, max) + marker;
}

function isQuickSetThread(thread: ThreadChannel) {
  return /\[TCGDEX:[^\]]+\]$/.test(thread.name);
}

function extractSetId(thread: ThreadChannel): string | null {
  const match = thread.name.match(/\[TCGDEX:([^\]]+)\]$/);
  return match?.[1] ?? null;
}

function setEmbed(set: SetData, language: TcgLanguage, index: number, total: number) {
  const fields: APIEmbedField[] = [
    { name: 'Set', value: set.name || set.id, inline: true },
    { name: 'Set ID', value: `\`${set.id}\``, inline: true },
    { name: 'Series', value: set.serie?.name ?? 'Unknown', inline: true },
    { name: 'Release date', value: set.releaseDate ?? 'Unknown', inline: true },
    { name: 'Cards', value: `${set.cardCount?.official ?? '?'} official / ${set.cardCount?.total ?? '?'} total`, inline: true },
    { name: 'Language', value: LANGUAGE_LABELS[language], inline: true },
  ];

  const embed = new EmbedBuilder()
    .setTitle(`${set.name} — Card List`)
    .setDescription(`Set **${index + 1} of ${total}**\nChoose a sort below to publish the cards in this post.`)
    .addFields(fields)
    .setFooter({ text: 'Data and images: TCGdex' });
  if (set.logo ?? set.symbol) embed.setThumbnail(set.logo ?? set.symbol!);
  return embed;
}

function cardEmbed(card: CardData) {
  const embed = new EmbedBuilder()
    .setTitle(card.name || 'Unknown card')
    .addFields(
      { name: 'Number', value: String(card.localId), inline: true },
      { name: 'Rarity', value: card.rarity ?? 'Unknown', inline: true },
    )
    .setFooter({ text: 'TCGdex' });
  if (card.image) embed.setImage(`${card.image}/high.webp`);
  return embed;
}

function sortCards(cards: CardData[], key: SortKey, order: SortOrder) {
  const direction = order === 'asc' ? 1 : -1;
  return [...cards].sort((a, b) => {
    if (key === 'name') return String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' }) * direction;
    if (key === 'rarity') return (a.rarity ?? 'Unknown').localeCompare(b.rarity ?? 'Unknown', undefined, { sensitivity: 'base' }) * direction;
    return compareCardNumber(String(a.localId), String(b.localId)) * direction;
  });
}

function compareCardNumber(a: string, b: string) {
  const parse = (v: string): readonly [number, string] => {
    const m = v.match(/^(\d+)(.*)$/);
    return m ? [Number(m[1]), m[2]] as const : [Number.MAX_SAFE_INTEGER, v];
  };
  const [an, as] = parse(a);
  const [bn, bs] = parse(b);
  return an - bn || as.localeCompare(bs, undefined, { numeric: true });
}

async function fetchFullCards(lang: TcgLanguage, set: SetData) {
  const briefs = set.cards ?? [];
  const cards: CardData[] = [];
  const concurrency = 6;
  let cursor = 0;

  async function worker() {
    while (cursor < briefs.length) {
      const i = cursor++;
      const brief = briefs[i];
      try {
        cards[i] = await getCard(lang, brief.id);
      } catch (error) {
        console.error(`Card fetch failed ${brief.id}:`, error);
        cards[i] = { ...brief, rarity: 'Unknown' };
      }
      await sleep(75);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, briefs.length) }, worker));
  return cards.filter(Boolean);
}

async function sendCardPages(thread: ThreadChannel, cards: CardData[]) {
  // Discord allows up to 10 embeds per message. Keeping one card per embed
  // still makes each forum post easy to browse while staying under message limits.
  for (let i = 0; i < cards.length; i += 10) {
    const chunk = cards.slice(i, i + 10);
    await thread.send({ embeds: chunk.map(cardEmbed) });
    await sleep(150);
  }
}

async function findForumThreads(forum: ForumChannel): Promise<ThreadChannel[]> {
  const found = new Map<string, ThreadChannel>();
  const active = await forum.threads.fetchActive();
  for (const thread of active.threads.values()) if (isQuickSetThread(thread)) found.set(thread.id, thread);

  let before: string | undefined;
  for (let page = 0; page < 50; page++) {
    const archived = await forum.threads.fetchArchived({ type: 'public', limit: 100, before });
    for (const thread of archived.threads.values()) if (isQuickSetThread(thread)) found.set(thread.id, thread);
    if (!archived.hasMore || archived.threads.size === 0) break;
    const oldest = [...archived.threads.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp)[0];
    if (!oldest) break;
    before = oldest.id;
  }
  return [...found.values()];
}

async function getExistingSetIds(forum: ForumChannel) {
  const threads = await findForumThreads(forum);
  return new Set(threads.map(extractSetId).filter((x): x is string => Boolean(x)));
}

async function postSet(forum: ForumChannel, set: SetData, language: TcgLanguage, index: number, total: number) {
  const thread = await forum.threads.create({
    name: threadName(index, set),
    message: {
      content: setMarker(set.id),
      embeds: [setEmbed(set, language, index, total)],
      components: [sortSelect(`quickset:sort:${language}:${set.id}`)],
    },
    reason: `QuickSet ${LANGUAGE_LABELS[language]} — ${set.name}`,
  });
  return thread;
}

async function startQuickSet(interaction: ChatInputCommandInteraction) {
  await interaction.reply({
    content: '**QuickSet setup — step 1/2**\nChoose the language to use for the set and card names.',
    components: [languageSelect('quickset:language')],
    ephemeral: true,
  });
}

async function handleQuickSetLanguage(interaction: StringSelectMenuInteraction) {
  const language = interaction.values[0] as TcgLanguage;
  await interaction.update({
    content: `**QuickSet setup — step 2/2**\nLanguage: **${LANGUAGE_LABELS[language]}**\nNow choose the forum.`,
    components: [forumSelect(`quickset:forum:${language}`)],
  });
}

async function safeEdit(interaction: any, content: string) {
  try { await interaction.editReply(content); } catch (error) { console.warn('Interaction update skipped:', error); }
}

async function runQuickSet(interaction: any, language: TcgLanguage, forum: ForumChannel) {
  await interaction.update({
    content: `⏳ Starting QuickSet in **${forum.name}** using **${LANGUAGE_LABELS[language]}**.\nFetching the set list from TCGdex…`,
    components: [],
  });

  const sets = await getSets(language);
  let posted = 0;
  let failed = 0;

  for (let i = 0; i < sets.length; i++) {
    const brief = sets[i];
    try {
      const full = await getSet(language, brief.id);
      await postSet(forum, full, language, i, sets.length);
      posted++;
      await sleep(300);
      if (posted % 10 === 0) {
        await safeEdit(interaction, `⏳ QuickSet is posting sets… **${posted}/${sets.length}** created.`);
      }
    } catch (error) {
      failed++;
      console.error(`Failed to post set ${brief.id}:`, error);
    }
  }

  await interaction.editReply(
    `✅ **QuickSet complete**\nCreated **${posted}** set posts in ${forum}.` +
      (failed ? `\n⚠️ **${failed}** sets failed and can be recovered with **/set continue**.` : '') +
      `\n\nEach set post has its own sort menu.`,
  );
}

async function continueSets(interaction: ChatInputCommandInteraction) {
  await interaction.reply({
    content: '**Continue setup — step 1/2**\nChoose the language used by the set posts you want to continue.',
    components: [languageSelect('continue:language')],
    ephemeral: true,
  });
}

async function handleContinueLanguage(interaction: StringSelectMenuInteraction) {
  const language = interaction.values[0] as TcgLanguage;
  await interaction.update({
    content: `**Continue setup — step 2/2**\nLanguage: **${LANGUAGE_LABELS[language]}**\nChoose the forum to scan and continue.`,
    components: [forumSelect(`continue:forum:${language}`)],
  });
}

async function runContinue(interaction: any, language: TcgLanguage, forum: ForumChannel) {
  await interaction.update({
    content: `🔎 Checking ${forum} for existing TCGdex set posts…`,
    components: [],
  });

  const [sets, existing] = await Promise.all([getSets(language), getExistingSetIds(forum)]);
  const missing = sets.filter((set) => !existing.has(set.id));

  if (!missing.length) {
    await safeEdit(interaction, `✅ No missing sets found. All **${sets.length}** TCGdex sets are already flagged in ${forum}.`);
    return;
  }

  const preview = missing.slice(0, 15).map((s) => `• ${s.name} \`${s.id}\``).join('\n');
  await interaction.editReply(
    `🚩 **${missing.length} sets are missing from ${forum}.**\n\n${preview}` +
      (missing.length > 15 ? `\n…and ${missing.length - 15} more.` : '') +
      `\n\nContinuing in oldest → newest order…`,
  );

  let posted = 0;
  let failed = 0;
  const total = sets.length;

  for (const brief of missing) {
    const originalIndex = sets.findIndex((s) => s.id === brief.id);
    try {
      const full = await getSet(language, brief.id);
      await postSet(forum, full, language, originalIndex, total);
      posted++;
      await sleep(300);
      if (posted % 10 === 0) await interaction.editReply(`⏳ Continuing… **${posted}/${missing.length}** missing set posts created.`);
    } catch (error) {
      failed++;
      console.error(`Continue failed ${brief.id}:`, error);
    }
  }

  await interaction.editReply(
    `✅ **Continue complete**\nAdded **${posted}** missing set posts.` +
      (failed ? `\n⚠️ **${failed}** failed; run **/set continue** again after checking permissions/API access.` : ''),
  );
}

async function handleSort(interaction: StringSelectMenuInteraction) {
  const [, , languageRaw, setId] = interaction.customId.split(':');
  const language = languageRaw as TcgLanguage;
  const [key, order] = interaction.values[0].split(':') as [SortKey, SortOrder];
  const thread = interaction.channel;

  if (!thread?.isThread()) {
    await interaction.reply({ content: 'This menu can only be used inside a QuickSet forum post.', ephemeral: true });
    return;
  }

  await interaction.deferUpdate();
  await interaction.editReply({
    content: `⏳ Loading **${setId}** cards and sorting by **${key} (${order})**…`,
    components: [],
  });

  try {
    const set = await getSet(language, setId);
    const cards = sortCards(await fetchFullCards(language, set), key, order);
    await interaction.editReply({
      content: `📚 **${set.name}** — ${cards.length} cards\nSort: **${sortLabel(key, order)}**`,
      components: [],
    });
    await sendCardPages(thread, cards);
    await thread.send({ content: `✅ Finished posting **${cards.length} cards** for **${set.name}**.` });
  } catch (error) {
    console.error(error);
    await interaction.editReply({ content: '❌ I could not load this set from TCGdex. Check the bot logs and try again.' });
  }
}

function sortLabel(key: SortKey, order: SortOrder) {
  if (key === 'name') return order === 'asc' ? 'A–Z ascending' : 'Z–A descending';
  if (key === 'number') return order === 'asc' ? 'Card number ascending' : 'Card number descending';
  return order === 'asc' ? 'Rarity ascending' : 'Rarity descending';
}

async function registerCommands() {
  const commands = [
    {
      name: 'quickset',
      description: 'Post one TCGdex forum post for every Pokémon TCG set.',
    },
    {
      name: 'set',
      description: 'Manage TCGdex set posts.',
      options: [
        {
          type: 1,
          name: 'continue',
          description: 'Find and post any TCGdex sets missing from a forum.',
        },
      ],
    },
  ];

  const rest = new REST({ version: '10' }).setToken(TOKEN!);
  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID!, GUILD_ID), { body: commands });
    console.log(`Registered commands in guild ${GUILD_ID}`);
  } else {
    await rest.put(Routes.applicationCommands(CLIENT_ID!), { body: commands });
    console.log('Registered global commands');
  }
}

client.once(Events.ClientReady, async (ready) => {
  console.log(`Logged in as ${ready.user.tag}`);
  try {
    await registerCommands();
  } catch (error) {
    console.error('Command registration failed:', error);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'quickset') return startQuickSet(interaction);
      if (interaction.commandName === 'set' && interaction.options.getSubcommand() === 'continue') return continueSets(interaction);
    }

    if (interaction.isStringSelectMenu()) {
      if (interaction.customId === 'quickset:language') return handleQuickSetLanguage(interaction);
      if (interaction.customId.startsWith('continue:language')) return handleContinueLanguage(interaction);
      if (interaction.customId.startsWith('quickset:sort:')) return handleSort(interaction);
    }

    if (interaction.isChannelSelectMenu()) {
      const [, mode, language] = interaction.customId.split(':');
      const channel = interaction.channels.first();
      if (!channel || channel.type !== ChannelType.GuildForum) {
        await interaction.reply({ content: 'Please choose a forum channel.', ephemeral: true });
        return;
      }
      if (mode === 'forum' && interaction.customId.startsWith('quickset:')) {
        return runQuickSet(interaction, language as TcgLanguage, channel as ForumChannel);
      }
      if (mode === 'forum' && interaction.customId.startsWith('continue:')) {
        return runContinue(interaction, language as TcgLanguage, channel as ForumChannel);
      }
    }
  } catch (error) {
    console.error('Interaction error:', error);
    if (interaction.isRepliable()) {
      const message = '❌ Something went wrong. Check the Railway logs for details.';
      if (interaction.replied || interaction.deferred) await interaction.followUp({ content: message, ephemeral: true }).catch(() => {});
      else await interaction.reply({ content: message, ephemeral: true }).catch(() => {});
    }
  }
});

process.on('unhandledRejection', console.error);
process.on('uncaughtException', console.error);

client.login(TOKEN);
