# Аудит ТЗ Gonka Bot MVP

Документ для разработчика. Цель — зафиксировать все недочёты, противоречия, технические риски и неоднозначности в [Gonka_Bot_MVP_TZ_TypeScript.md](Gonka_Bot_MVP_TZ_TypeScript.md) **до** старта реализации, чтобы не упереться в них в коде.

Каждый пункт: где в ТЗ, что не так, что предлагается. Сортировка: критичные → высокие → средние → низкие → косметика.

---

## Критичные (блокируют MVP, решить до Недели 1-2)

### C1. `sendMessageDraft` — недоверенный API
**Где:** §8.2 (handleTextMessage), §9.1, §13.4 (Приложение C - "Bot API 9.5+ методы")
**Проблема:**
- ТЗ ссылается на `sendMessageDraft` и `Bot API 9.5+` как на штатный способ streaming. По данным веб-поиска есть упоминания, но **источники неоднозначные** (часть — AI-сгенерированный контент). Не подтверждено вручную по `core.telegram.org/bots/api-changelog`.
- Если метод **не существует** или ещё не доступен — половина ТЗ §8.2 неработоспособна.
- В ТЗ нет fallback-кода, только упоминание "есть в коде" (Приложение C) — на деле его нет.
**Действие:**
1. Открыть `core.telegram.org/bots/api-changelog` и убедиться, что Bot API 9.5+ выпущен и `sendMessageDraft` существует.
2. Проверить, есть ли метод в `@grammyjs/types` последней версии. Если нет — дёргать через `bot.api.raw.callApi('sendMessageDraft', ...)`.
3. **Приготовить fallback** = `sendMessage` (первый чанк) + `editMessageText` с throttle 500 мс / 2 edit/sec на сообщение. Реализовать как абстракцию `StreamingTextSink` с двумя имплементациями.

---

### C2. Несовместимость файлов handler'ов: `.py` vs TypeScript
**Где:** §7 — таблица команд показывает `handlers/start.py`, `handlers/voice.py`, и т.д.
**Проблема:** Проект на **TypeScript**, файлы должны быть `.ts`. К тому же структура проекта в §3 — `src/bot/composers/start.ts`, а не `handlers/`. Прямое противоречие внутри одного документа.
**Действие:** Игнорировать §7-таблицу в части путей. Использовать `src/bot/composers/*.ts` из §3.

---

### C3. `composers/start.ts` отвечает за две команды
**Где:** §7 — `/lang` → `handlers/start.py`
**Проблема:** Странно, что `/lang` маппится на `start`. По §3 есть отдельный `lang.ts`. Скорее всего опечатка в ТЗ.
**Действие:** Реализовать в `src/bot/composers/lang.ts` как отдельный composer. Не следовать §7.

---

### C4. `z.coerce.boolean()` не работает как ожидается
**Где:** §4 — `FEATURE_VOICE_INPUT: z.coerce.boolean().default(true)` и т.д.
**Проблема:** `z.coerce.boolean()` приводит **любую непустую строку** к `true`. Значения `"false"`, `"0"`, `"no"` из `.env` дадут `true` — то есть **kill_switch=false из env превратится в true**. Это критичный баг безопасности.
**Действие:** Заменить на `z.enum(['true', 'false']).transform(v => v === 'true')` или кастомный preprocess:
```ts
const boolFromEnv = z.string().transform(v => v === 'true' || v === '1');
KILL_SWITCH: boolFromEnv.default('false'),
```
То же для `FEATURE_*`.

---

### C5. `ADMIN_TG_IDS` — тип после трансформации
**Где:** §4 — `ADMIN_TG_IDS: z.string().transform((s) => s.split(',').map((x) => Number(x.trim())).filter(Boolean))`
**Проблема:** В `Env`-типе после `z.infer` получится `number[]`, но в `killSwitchMiddleware` (§11.3) пишут `env.ADMIN_TG_IDS.includes(ctx.from?.id ?? 0)` — это OK. А вот `.filter(Boolean)` отфильтрует `0` (валидный, но маловероятный TG ID) и `NaN`. NaN-фильтр это нормально, но если в env пробел/мусор — он будет тихо проглочен.
**Действие:** Добавить validation: `.filter(n => Number.isFinite(n) && n > 0)`. Также через `.min(1)` проверять, что хоть один admin задан.

---

### C6. `getMessagesForLlm` теряет system prompt при trim
**Где:** §6.9 — "trim самые старые (system prompt сохраняется)"
**Проблема:** В DB-схеме (§5) у `messages` есть `role: 'system' | 'user' | 'assistant'`, но в флоу §8.2 system prompt **строится на лету** (`persona.renderSystemPrompt`) и **в БД не сохраняется**. Значит, при trim защищать нечего — system prompt уже отдельно. Формулировка ТЗ путает.
**Действие:** Уточнить: `getMessagesForLlm` возвращает только `user`/`assistant`, тримим самые старые `user`/`assistant` пары (тримить пару, чтобы не оставить orphan-assistant без user). System prompt инжектится в `chat.ts` уже после.

---

### C7. Streaming + output moderation — race condition
**Где:** §8.2 шаги 6→7→8 (handleTextMessage)
**Проблема:** Сценарий:
1. Шлём draft-чанки юзеру по мере накопления.
2. После завершения стрима — output moderation.
3. Если block — `ctx.reply(t('moderation.output_blocked'))`.

Но **юзер уже видит** частичный harmful ответ через draft! Output moderation post-factum его не уберёт. Если draft эфемерный (TTL 30 сек, ТЗ не уточняет) — юзер всё равно успел прочитать.
**Действие:**
- Вариант A: модерировать **на каждом chunk-batch** (~ каждые 500 знаков), при block — немедленно остановить стрим и заменить draft на blocked-message.
- Вариант B: стримить во временное "typing..." сообщение/draft, потом единым `editMessageText` отдавать финал. Юзер видит "typing" → готовый ответ.
- Вариант C: модерировать только финал, но draft писать в hidden way. Telegram не даёт hidden, поэтому это нереалистично.

Рекомендация: **Вариант B** для MVP — проще, безопаснее. Streaming-эффект достигается через быстрые edit'ы накапливающегося буфера.

---

### C8. Conversation для документа — два разных подхода в ТЗ
**Где:** §8.4 (handleDocumentUpload, шаг 6) vs §6.9 (ConversationService.attachDocument)
**Проблема:** В §8.4 — `startNew(user.id)` + `attachDocument`. В §6.9 интерфейс позволяет `attachDocument` к **любой** conversation. Не уточнено, что делать если пользователь уже в активном диалоге, кидает PDF — потерять контекст? Спросить?
**Действие:** Определиться: документ всегда стартует **новую** conversation (как в §8.4). Старая закрывается (`isActive=false`). В UX-копирайтинг добавить ключ "started new conversation with document".

---

### C9. Privacy mode + reply-to-bot
**Где:** §8.6, §13.4 (`/setprivacy Enable`)
**Проблема:** Privacy mode = ON означает, что бот в группе **получает только** сообщения с `@bot_username` или commands. **Не** получает reply на свои сообщения, если в reply нет `@mention`. Но §8.6 строит флоу на `replyTo.from?.id === ctx.me.id`. Это работать **не будет** при privacy ON. Противоречие.
**Действие:** Выбрать одно:
- **Privacy ON** — отказаться от "reply continues thread", оставить только `@mention`. Проще, безопаснее.
- **Privacy OFF** — бот видит все сообщения группы, фильтруем сами. Сложнее, риск утечки. Требует жёсткой фильтрации перед moderation.

Рекомендация для MVP: **Privacy ON, только @mention**. "Reply-to-bot для продолжения треда" перенести в Phase 2.

---

### C10. Webhook secret token не проверяется в Hono
**Где:** §2 — `webhookCallback(bot, 'hono', { secretToken: env.WEBHOOK_SECRET })`
**Проблема:** `secretToken` опция grammY **сравнивает** header `X-Telegram-Bot-Api-Secret-Token` с ожидаемым. Но Hono adapter в старых версиях grammY мог не пробрасывать headers корректно. Также если за Caddy — secret может теряться. Без проверки secret любой может слать webhook fake-payload на ваш `/webhook`.
**Действие:**
1. Проверить версию grammY ≥ 1.30 и тест-нагрузить webhook с неправильным secret — должен дать 401.
2. В Caddyfile **явно** пробрасывать `X-Telegram-Bot-Api-Secret-Token`.
3. В тестах: integration-тест с правильным/неправильным secret.

---

## Высокие (важно, решить в первые 2 недели)

### H1. `voice.synthesize` возвращает MP3, но `replyWithVoice` ожидает OGG/Opus
**Где:** §6.4 (Edge-TTS → MP3) vs §8.2 шаг 11 (`ctx.replyWithVoice(... 'response.mp3')`)
**Проблема:** Telegram API: `sendVoice` принимает **OGG в формате Opus**. MP3 не воспроизведётся как voice message, попадёт как audio. Файл `'response.mp3'` через `sendVoice` будет либо отклонён, либо отрендерён как audio-файл с обложкой.
**Действие:**
- Либо отдавать через `ctx.replyWithAudio` (audio-плеер, не воспроизводится как голосовое).
- Либо конвертить MP3 → OGG/Opus через `fluent-ffmpeg` (зависимость на ffmpeg в Docker image).
- Либо использовать Edge-TTS формат `AUDIO_24KHZ_48KBITRATE_MONO_MP3` → конвертить → OGG.

Рекомендация: **добавить ffmpeg в Docker image** и конвертить. Альтернатива — OpenAI TTS с output format = `opus` — но это $.

---

### H2. SSE-парсер handcrafted без указания формата
**Где:** §6.1 — "SSE-парсинг: реализовать вручную через `response.body.getReader()` + `TextDecoder`"
**Проблема:** mingles.ai gateway документация **не приложена**. Не указано:
- Какой EOL (`\n` или `\r\n`)?
- Может ли один `data:` event разбиться на несколько TCP-чанков? (да, может).
- Что делать с `[DONE]` маркером (ТЗ показывает в §9.1 как `data: [DONE]`).
- Кейс пустых keep-alive `: ping\n\n`.
**Действие:** Реализовать аккуратно с буферизацией:
```
buffer += new TextDecoder().decode(chunk)
while ((idx = buffer.indexOf('\n\n')) !== -1):
  event = buffer.slice(0, idx)
  buffer = buffer.slice(idx + 2)
  parseEvent(event)
```
Покрыть тестами на разбиение чанков посередине события. Альтернатива — взять готовый `eventsource-parser` (npm, ~ 5KB).

---

### H3. tiktoken для **Kimi** даёт неточные оценки
**Где:** §6.5, §6.9, §11.2 — tiktoken для подсчёта токенов
**Проблема:** tiktoken — это OpenAI BPE-токенайзер (cl100k/o200k). Kimi K2.6 использует **другой** токенайзер (близкий к Qwen). Оценка может расходиться на 20-30%. Это влияет на:
- Trim истории при `> 200K` — можем недозаполнить или переполнить контекст.
- Cost tracking — расхождение с `usage` от gateway.
**Действие:**
- В нормальном флоу — **доверять `usage` из ответа gateway** (он точный). tiktoken только для предварительной оценки (например, "поместится ли документ" — давать запас 30%).
- Не считать cost через tiktoken — только через `usage` из стрима. Если `usage` отсутствует — логировать warning, использовать tiktoken-оценку как fallback.

---

### H4. Кейс: rate limit ≥ limit vs > limit
**Где:** §11.1 — `if ((current as number) > limit) → not allowed`
**Проблема:** `INCR` возвращает значение **после** инкремента. Если limit = 30 и юзер сделал 30 запросов — `current = 31` после следующего инкремента. Но 31-й запрос мы уже **посчитали и сразу же отвергли**. То есть юзер реально успел 30, не 31. OK, но **счётчик инкрементируется даже при отказе** — это засчитывает попытку как использование. Может быть intentional, но стоит уточнить.
**Действие:** Принять как есть (даже отвергнутый запрос грузит rate limit — защита от спама /start'ом). Документировать.

---

### H5. Cost tracker: race condition в alert deduplication
**Где:** §11.2 — `if (overAlert && !(await redis.get('cost:alerted:${today}')))`
**Проблема:** Между `get` и `set` другой запрос может пройти ту же проверку → двойной алерт. Не критично, но при высоком RPS возможно.
**Действие:** Использовать атомарный `SET ... NX EX 86400`:
```ts
const ok = await redis.set(`cost:alerted:${today}`, '1', 'NX', 'EX', 86_400);
if (ok === 'OK' && overAlert) bot.api.sendMessage(...)
```

---

### H6. Kill switch live race
**Где:** §11.3 (killSwitchMiddleware)
**Проблема:** Middleware читает `redis.get('kill_switch')` на **каждом update** — это лишний round-trip к Redis. На бот с 100 RPS это даст 100 GET/sec на Redis. Не страшно, но можно оптимизировать кешем in-memory с TTL 5-10 секунд.
**Действие:** Не оптимизировать в MVP. Если станет узким местом — добавить in-memory cache.

---

### H7. Voice rate limit считается **до** Whisper, но не до конца pipeline
**Где:** §8.3 — rate limit 'voice' инкрементируется в начале handler.
**Проблема:** Если Whisper упал (ошибка) — слот voice-лимита уже потрачен. Юзер потерял 1 из 5 голосовых ни за что.
**Действие:** Либо принять (защита от спама), либо при ошибке Whisper откатывать счётчик (`DECR`). Рекомендация: **принять**, в `t('error.voice_failed')` упомянуть "лимит не был списан" если откатываем, или ничего если нет.

---

### H8. `/report` — на что репортит?
**Где:** §16 acceptance — "/report создаёт запись и уведомляет админа", §7 — "сообщить о проблеме (последний ответ)"
**Проблема:** Как определить "последний ответ"? Юзер ввёл /report — на какое сообщение это reply? Если юзер отправил /report в reply на сообщение бота — берём это сообщение. Если просто /report — берём последнее `assistant`-сообщение из активного conversation. ТЗ не уточняет.
**Действие:** Реализовать оба:
- Если `ctx.message.reply_to_message?.from?.is_bot` — репорт на это.
- Иначе — берём последнее `assistant` из активной conversation.
- Если ничего нет — `t('report.nothing_to_report')`.

---

### H9. Age gate: "/start again after some time"
**Где:** §8.1 шаг 4 — "On No: ... user can /start again after some time"
**Проблема:** Не указано, через какое время. Сейчас ничто не мешает юзеру /start → No → /start → Yes → bypass. **Дыра в age gate.**
**Действие:** Сохранять `age_rejected_at` и блокировать повторную попытку на **30 дней** (или сколько решим). Альтернатива — давать второй шанс (если юзер ошибся), но не больше. В DB-схеме (§5) нет поля `age_rejected_at` — добавить миграцией.

---

### H10. ToS versioning
**Где:** §5 — `tos_version: text('tos_version')`, §8.1 — `tosVersion = '1.0'`
**Проблема:** Если ToS обновится (1.1, 2.0) — как уведомлять юзеров о необходимости пере-accept? В ТЗ механизма нет.
**Действие:** В config добавить `CURRENT_TOS_VERSION`. В auth middleware проверять `user.tos_version !== env.CURRENT_TOS_VERSION` → редирект на ToS flow. В MVP — оставить 1.0, механизм добавить в Phase 1.1.

---

### H11. Permanent ban для sexual/minors не специфицирован в коде
**Где:** §10.3, §16 — "Sexual/minors категория → сразу `banned_permanent = TRUE`"
**Проблема:** В `ModerationService` интерфейсе (§6.2) и audit-log примере (§10.4) не показан этот special case. Легко забыть.
**Действие:** В `moderation.checkInput/Output` добавить **explicit check**: если `categories['sexual/minors']` (то самое название категории в OpenAI API — `sexual/minors`, **с слешем**) и score ≥ threshold → `users.bannedPermanent = true`, **до** инкремента flag_count. Также — мгновенный admin alert.

---

### H12. moderation thresholds: имена категорий
**Где:** §4 — `MOD_THRESHOLD_SEXUAL_MINORS`, §10
**Проблема:** OpenAI Moderation API возвращает категории: `sexual`, `sexual/minors`, `hate`, `hate/threatening`, `harassment`, `harassment/threatening`, `self-harm`, `self-harm/intent`, `self-harm/instructions`, `violence`, `violence/graphic`. ТЗ упрощает до 6: `harm`, `violence`, `hate`, `self_harm`, `sexual`, `sexual_minors`. Маппинг **не описан**.
**Действие:** Явный маппинг в `moderation.ts`:
```ts
const CATEGORY_MAP = {
  'sexual/minors': 'sexualMinors',
  'sexual': 'sexual',
  'hate': 'hate',
  'hate/threatening': 'hate',
  'harassment': 'harm',
  'harassment/threatening': 'harm',
  'self-harm': 'selfHarm',
  'self-harm/intent': 'selfHarm',
  'self-harm/instructions': 'selfHarm',
  'violence': 'violence',
  'violence/graphic': 'violence',
};
```

---

## Средние (учесть, не блокеры)

### M1. `noUncheckedIndexedAccess: true` + handcrafted parsing
**Где:** §2 — tsconfig strict
**Проблема:** С этой опцией `messages[0]` имеет тип `T | undefined`. Многие примеры в ТЗ пишут `response.results[0]!` (§9.2) — это `!` глушит, но небезопасно.
**Действие:** В services — проверять с явной ошибкой:
```ts
const first = response.results[0];
if (!first) throw new Error('Empty moderation response');
```
Не использовать `!` без understanding почему.

---

### M2. `exactOptionalPropertyTypes: true` ломает совместимость с grammY-typings
**Где:** §2
**Проблема:** Эта опция строже стандарта — нельзя передавать `undefined` в optional поле. grammY's API типизация часто допускает `field?: T | undefined` либо `field?: T` без union. Может выскочить десяток type errors при wiring grammY API.
**Действие:** Если упрёмся — отключить `exactOptionalPropertyTypes` локально (хорошая опция, но не критичная). Решение по факту.

---

### M3. `pino-pretty` в Docker alpine
**Где:** §12.1
**Проблема:** `pino-pretty` через `transport` запускает worker-thread. На alpine иногда падает на missing `libuv` symbols.
**Действие:** В dev — `pino-pretty` через pipe (`pnpm dev | pnpm pino-pretty`), в prod — чистый JSON без transport. В Docker LOG_FORMAT=json hardcoded.

---

### M4. Drizzle relations объявлены, но не показаны в схеме
**Где:** §3 — `relations.ts` в структуре, но в §5 не показано
**Действие:** Reference: `https://orm.drizzle.team/docs/rqb` — описать relations для users↔conversations, conversations↔messages, conversations↔personas, audit_log↔users.

---

### M5. Migrations: не указан подход в Docker entrypoint
**Где:** §13 deployment
**Проблема:** `docker compose exec bot node dist/scripts/migrate.js` — это **ручная** команда. В prod миграции должны накатываться **автоматически** при `docker compose up` (idempotent).
**Действие:** В Dockerfile `CMD ["sh", "-c", "node dist/scripts/migrate.js && node dist/main.js"]`. Идемпотентность гарантирует drizzle.

---

### M6. Backup: pg_dump cron — где?
**Где:** §16 acceptance #23 — "Бэкап Postgres настроен"
**Проблема:** Не описано, где живёт cron. На хосте или в отдельном sidecar контейнере?
**Действие:** Простейший вариант — host-cron (`crontab -e`):
```
0 3 * * * docker exec gonka-bot-postgres-1 pg_dump -U gonka gonka_bot | gzip > /backups/dump_$(date +\%F).sql.gz
```
+ retention 14 дней через `find /backups -mtime +14 -delete`.

---

### M7. Group conversation — utf8-username
**Где:** §8.6 `stripMention(ctx.message!.text!, env.BOT_USERNAME)`
**Проблема:** В сообщении могут быть `entities` типа `mention` — лучше использовать их offset/length, чем regex по username. Учесть case-insensitive.
**Действие:** Использовать `ctx.message.entities` для надёжного извлечения. Fallback на string match.

---

### M8. Persona switching — старая conversation не закрывается
**Где:** §8.5 — `startNew(ctx.user.id, { personaId })`, потом `users.update({ activeConversationId: conv.id })`
**Проблема:** Старая active conversation остаётся с `isActive=true` в БД (только в users указатель сменился). Возможен дрейф: несколько conversations с `isActive=true` для одного юзера.
**Действие:** В `startNew` транзакционно: пометить старые `isActive=false` для этого user, создать новую. Либо использовать `users.activeConversationId` как single source of truth и забыть про `isActive` флаг на conversations — выбрать одно.

---

### M9. `flag_count_week` сброс
**Где:** §10.3 — "Раз в неделю поле сбрасывается (cron job или ленивая проверка при инкременте)"
**Проблема:** Два варианта реализации, выбор не сделан. Ленивая проверка проще (нет cron), но усложняет каждую запись.
**Действие:** **Ленивая**: при инкременте проверять `flag_count_week_reset_at < NOW() - 7d` → reset to 0, then increment. Single SQL update with CASE.

---

### M10. Document moderation на первых 50K — обход
**Где:** §8.4 шаг 5 — "Moderate first 50K chars"
**Проблема:** Юзер может вшить harmful payload **после** 50K границы. Документ пройдёт модерацию.
**Действие:** Принять для MVP (50K покрывает 99% документов целиком — средний PDF меньше). В audit-log добавлять метку "doc_moderated_prefix_only" с размером. Если потребуется — pass chunks через moderation, дороже но безопаснее.

---

### M11. `getOrCreateActive` race на старте
**Где:** §6.9
**Проблема:** Если юзер шлёт два сообщения параллельно (быстрая печать + voice одновременно), может создаться 2 active conversation. Уникальный индекс по `(user_id, is_active=true)` где `is_active=true` — спасёт через `ON CONFLICT`.
**Действие:** Partial unique index в Postgres:
```sql
CREATE UNIQUE INDEX uniq_user_active_conv ON conversations(user_id) WHERE is_active = true;
```
+ ловить unique violation и retry-read.

---

### M12. Voice file size limit не описан
**Где:** §8.3, §6.4
**Проблема:** Whisper принимает до 25MB. Telegram voice messages — до 1 час / ~20MB. Но юзер может прислать как `audio` файл — гораздо больше. ТЗ молчит.
**Действие:** В voice composer проверять `ctx.message.voice.file_size` и `ctx.message.audio?.file_size` ≤ 25MB. Иначе `t('voice.too_large')`.

---

### M13. `chatComplete` упоминается, но не используется
**Где:** §6.1
**Проблема:** Интерфейс есть, флоу — нет. В §15 не упоминается.
**Действие:** Реализовать сразу. Использовать для **auto-генерации title** диалога после 3-5 ходов (улучшит "list conversations" в Phase 2). Не показывать пока в UX, копить в `conversations.title`.

---

### M14. i18n locale в ar/zh — нет проверки рендеринга
**Где:** §15 Неделя 5, §14.3 чек-лист
**Проблема:** Telegram нормально рендерит RTL (AR) и CJK (ZH), но кастомные клавиатуры/inline buttons могут ломаться. Не проверено.
**Действие:** В Manual QA — пройти по каждой локали полный флоу (включая клавиатуры, не только тексты).

---

### M15. Кеш отсутствует
**Где:** Всё
**Проблема:** Нет кеширования identical Whisper-транскрипций (приложение C предлагает в risks). Один и тот же voice (по hash) — повторно отправляем на Whisper. На массовом запуске — лишние деньги.
**Действие:** Не делаем в MVP. В Phase 1.1 — sha256-hash voice → Redis cache транскрипции с TTL 7 дней.

---

### M16. AsyncIterable + AbortSignal — корректность отмены
**Где:** §6.1 — `signal?: AbortSignal`
**Проблема:** Если юзер шлёт /new во время стрима, надо отменить текущий запрос. ТЗ передаёт signal, но не показывает, **как** его привязать к user-action.
**Действие:** Хранить активные `AbortController` per user в Redis или in-memory `Map<UserId, AbortController>`. В `/new` — abort. Сложно, в MVP можно опустить (ждать конца стрима, потом /new).

---

### M17. Reply markup на каждом сообщении бота
**Где:** §8.2 шаг 8 — `reply_markup: buildReportKeyboard()`
**Проблема:** Если на каждое assistant-сообщение прицеплять "Report" кнопку, чат становится визуально захламлённым.
**Действие:** Прицеплять только если cost-effective — например, "Report" кнопка только на длинных ответах (>500 chars), или совсем убрать в пользу команды `/report`. Решение UX — спросить пользователя позже.

---

## Низкие (косметика, оптимизации, документация)

### L1. Versions: docker-compose.yml `version: '3.9'` deprecated
**Где:** §13.1
**Действие:** Убрать `version:` строку — Compose v2 её игнорирует и пишет warning.

---

### L2. `numeric('cost_usd', { precision: 10, scale: 8 })`
**Где:** §5 — `messages.costUsd`
**Проблема:** precision=10, scale=8 → максимум 99.99999999. На один message — нормально, но узко (LLM cost $1+ за длинный ответ возможен). Лучше precision=12, scale=8.
**Действие:** scale OK, precision поднять до 12.

---

### L3. `bigserial` vs `bigint identity`
**Где:** §5
**Проблема:** `bigserial` deprecated в Postgres 10+, использовать `bigint generated always as identity`.
**Действие:** Косметика. Drizzle сам генерит OK. Не трогать.

---

### L4. `assert { type: 'json' }` deprecated
**Где:** §6.10
**Проблема:** В TS 5.4+ / Node 22 синтаксис `assert` deprecated, использовать `with { type: 'json' }`.
**Действие:** Использовать `with`. (Уже отмечено в плане Q6.)

---

### L5. `'9.5+'` API methods через `bot.api.raw.sendMessageDraft`
**Где:** §8.2 строка 1234 — `ctx.api.raw.sendMessageDraft(...)`
**Проблема:** `ctx.api.raw` ожидает snake_case method name + camelCase params. Не уверены, что метод существует в `raw`. Грамматика API call в grammY: `ctx.api.raw.send_message_draft` или `ctx.api.raw.sendMessageDraft`? Зависит от версии.
**Действие:** Проверить в `node_modules/@grammyjs/types`. Использовать `bot.api.callApi('sendMessageDraft', params)` как universal fallback.

---

### L6. msedge-tts — нет error handling в примере
**Где:** §9.4
**Проблема:** Пример просто стримит chunks. Что если соединение упадёт? Что если voice undefined?
**Действие:** Обернуть в try/catch, вернуть Result<Err>.

---

### L7. document handler — нет логирования
**Где:** §8.4
**Действие:** Логировать в pino: filename, size, mime, pages, tokens, latency_ms.

---

### L8. Caddyfile minimal
**Где:** §13.2
**Проблема:** Нет `header` директивы для security headers (HSTS, X-Frame-Options).
**Действие:** Добавить в Caddyfile:
```
header {
    Strict-Transport-Security "max-age=31536000"
    X-Content-Type-Options "nosniff"
    Referrer-Policy "strict-origin-when-cross-origin"
}
```

---

### L9. README отсутствует в Acceptance Недели 1
**Где:** §15 Неделя 1, §16 #24
**Действие:** Добавить README сразу — quick start, env table, deploy steps.

---

### L10. Health endpoint — что проверять?
**Где:** §15 Неделя 1
**Проблема:** Просто `{"status":"ok"}` ничего не значит. Liveness vs readiness.
**Действие:** `/health` — liveness (всегда 200 если процесс жив). Добавить `/ready` — readiness (200 если DB pingable + Redis pingable). Используется для healthcheck в Docker и LB.

---

### L11. Cron-jobs механизм не описан
**Где:** §10.4 — "Cron job раз в сутки", §11.2 — "resetDailyFlags"
**Проблема:** Нигде не описано, **как** запускаются. В Node? Внешний cron? BullMQ упомянут только для "Phase 2+".
**Действие:** Использовать `node-cron` (легковесная либа) в `main.ts`. Регистрировать таски при старте. Альтернатива — host cron вызывает `docker exec bot node dist/scripts/cleanup.js`. Выбрать — node-cron проще.

---

### L12. Логи не содержат `trace_id`
**Где:** §12.1
**Проблема:** Сложно проследить один запрос через несколько сервисов.
**Действие:** В logging middleware генерировать `trace_id` (`crypto.randomUUID()`) и передавать в child logger. Логи появятся в Pino structured logs.

---

### L13. `tokensInput`, `tokensOutput` могут быть **undefined**
**Где:** §6.1 — "только в финальном chunk"
**Проблема:** Если gateway не вернул usage — оба undefined. Cost не посчитается. Сейчас в §8.2 `tokensInput: finalUsage?.tokensInput ?? 0` — null-safe, но cost = 0 значит "бесплатно", что неверно.
**Действие:** Если usage undefined — оценить через js-tiktoken по `accumulated + history` для input и `accumulated` для output. Залогировать warning.

---

### L14. Personas системные промпты — на английском, но юзер русский
**Где:** Приложение A
**Проблема:** System prompt персонажа на английском, плюс `persona.renderSystemPrompt` добавляет инструкцию `"Respond in user lang"`. Это работает, но иногда модель отвечает на смеси языков (особенно с длинной системной инструкцией). Не критично.
**Действие:** Проверять в QA. Если случается — добавить в конец промпта `ALWAYS respond in: {userLang}`.

---

### L15. `replyWithVoice(new InputFile(...))` в Node 22
**Где:** §8.2 шаг 11
**Проблема:** `InputFile` в grammY принимает `Uint8Array | string | Blob | Stream`. Конструктор — `new InputFile(source, filename)`. Корректность синтаксиса не проверена.
**Действие:** Использовать `InputFile.fromBuffer(buf, 'response.ogg')` или `new InputFile({ source: buf }, 'response.ogg')` — зависит от версии grammY. Проверить по docs.

---

### L16. Локали — fallback на ключ vs на en
**Где:** §6.10
**Проблема:** Не описано: если ключа нет в локали — выкидывать ошибку, отдавать сам ключ ("missing.translation") или фоллбэк на en?
**Действие:** Fallback на `en`. Если и там нет — лог warning + сам ключ. В dev — кидать. В prod — graceful.

---

### L17. `vitest.config.ts` — coverage threshold не задан
**Где:** §14.1
**Действие:** Добавить `thresholds: { global: { lines: 70, branches: 60 } }` чтобы тесты валились при падении coverage.

---

### L18. Persona reload — yaml vs DB
**Где:** §15 Неделя 2 — "загрузить персонажей из yaml в БД при startup"
**Проблема:** Если обновить yaml после запуска — изменения не подтянутся. Не критично, но не очевидно.
**Действие:** На startup всегда делать upsert по slug. Документировать в README.

---

### L19. ADMIN_CHAT_ID — один чат?
**Где:** §4 — `ADMIN_CHAT_ID: z.coerce.number()`
**Проблема:** Один чат для всех алертов. Если хочется отдельный канал для critical vs обычных — нужно несколько.
**Действие:** В MVP один. В Phase 2 — расширить до `{ alerts: id, critical: id, reports: id }`.

---

### L20. Out-of-scope §17 пункты — где backlog?
**Где:** §17
**Действие:** Создать `BACKLOG.md` в репо. Перенести туда §17 с пометкой "Phase 2".

---

## Отсутствует в ТЗ (надо добавить или решить)

### A1. GDPR `/delete_my_data` упомянуто только в risks
**Где:** Приложение C
**Действие:** Реализовать команду минимально: cascade delete user + conversations + messages + audit_log соответствующего user. В MVP можно отложить, но **юридически нужно** — добавить хотя бы упоминание в ToS "напишите @admin для удаления".

### A2. Что показывать в `/about`
**Где:** §7, Приложение B (`about.text`)
**Действие:** Минимум: версия бота, ссылка на Gonka, ссылка на ToS, контакт админа.

### A3. Webhook setup secret — где хранить
**Где:** §13.3
**Действие:** Генерируется одноразово, хранится в `.env`. Документировать в README: `openssl rand -hex 32`.

### A4. Размер reply на длинные ответы (Telegram 4096 char limit)
**Где:** Не упомянуто
**Действие:** Если accumulated > 4000 chars — split на куски, отправлять последовательными `reply` (или используя `<pre>` если код). Универсальный split-helper по абзацам.

### A5. Persona system prompt + document text — overflow
**Где:** §6.6
**Проблема:** Если document 200K токенов — system prompt становится огромным. Kimi K2.6 contextWindow = 256K. Остаётся 56K на историю + ответ. Может не хватить.
**Действие:** Проверка перед отправкой: `len(system) + len(history) + maxTokens < 256000`. Если нет — пометить документ как "active reference" и не включать целиком, а через RAG. В MVP проще: ограничить документ 200K, оставить 56K зазор.

### A6. Multi-instance / horizontal scaling
**Где:** Не упомянуто
**Действие:** MVP — single instance. Документировать что webhook + Redis + Postgres готовы к scale, но bot-process пока один. Phase 2 — `BullMQ` для распределённой обработки.

### A7. Privacy policy ≠ ToS
**Где:** §8.1 — только ToS
**Действие:** Юридически нужна **Privacy Policy** отдельно. В MVP — объединить в один ToS-документ с разделом privacy. Текст пишет разработчик / юрист до запуска.

### A8. Тесты на `chat.ts` — не описаны
**Где:** §14
**Действие:** Добавить integration test `tests/integration/chat-flow.test.ts` — full flow от webhook до DB записи с моком Gonka, OpenAI. Использовать `testcontainers` для real Postgres+Redis.

### A9. Reverse proxy security: rate limit на webhook
**Где:** §13.2 (Caddyfile)
**Проблема:** Если кто-то узнает URL и шлёт мусор — Caddy не имеет rate limit.
**Действие:** В Caddyfile добавить `rate_limit` plugin или принять (защита secret token достаточна).

### A10. Конкретный план "deploy" в Неделе 7 — большой скоп
**Где:** §15 Неделя 7
**Действие:** Выделить "deploy на VPS" в **отдельную мини-фазу** (день в конце недели). Заранее сделать staging environment на том же VPS (другой port + другой бот в BotFather).

---

## Cross-reference / опечатки

- §7 `/lang` → `handlers/start.py` (опечатка, см. C3)
- §7 `handlers/*.py` везде (опечатка, см. C2)
- §3 структура — `compose**rs**` (composers), последовательно
- §6.4 — voice synthesize пример возвращает MP3, но handler ожидает OGG (см. H1)
- §11.1 — `redis.multi()...exec().then(...)` сигнатура зависит от версии ioredis. В ioredis v5 `.exec()` возвращает `[err, result][]`, не `result[]`. Пример в ТЗ упрощён, может не скомпилиться.
- §10.4 — `categories: { violence: true, harm: true }` vs §6.2 интерфейс `categories: Record<string, boolean>` — OK, но имена категорий должны строго мапиться (см. H12).
- §15 Неделя 2 упоминает `husky + lint-staged` в Неделе 1 — лучше перенести pre-commit к Неделе 2, после того как лефтовер кода появится.
- §16 #24 "README с deploy" — фактически готов к Неделе 7 (полная инструкция). Минимальный README — Неделя 1.

---

## Итог: метрика готовности ТЗ

| Категория | Кол-во |
|-----------|--------|
| Критичные (блокеры) | 10 |
| Высокие | 12 |
| Средние | 17 |
| Низкие | 20 |
| Отсутствует / добавить | 10 |
| Опечатки / cross-ref | 6+ |

**ТЗ покрывает архитектуру и стек на 90%**, UX-флоу на 80%, **техническая корректность кода-примеров — 60%** (много опечаток, deprecated синтаксис, неверные API-сигнатуры). Перед стартом каждой недели — **обязательно** возвращаться сюда и решать соответствующие пункты.

**Принцип:** не править ТЗ "молча" в коде. Спорные точки документировать в коде комментарием `// AUDIT-Cn: ...` со ссылкой на пункт этого файла.
