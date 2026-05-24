# Аудит ТЗ v1.1 — второй раунд

Документ: [Gonka_Bot_MVP_TZ_v1.1.md](Gonka_Bot_MVP_TZ_v1.1.md) (3109 строк).
Сравнение с [TZ_AUDIT.md](TZ_AUDIT.md) (первый раунд).

---

## Резюме

**Большой прогресс.** Из 75 пунктов первого аудита **закрыто 35** (все 10 критичных + 11/12 высоких + 8 средних + 6 низких).

**Но**: появились **новые дефекты** (5 шт.), **5 пунктов закрыты неполно** (фикс в одном месте — забыт в другом), и **15 пунктов из первого аудита проигнорированы**. Часть критичных дыр осталась.

---

## ❌ Новые дефекты в v1.1

### N1. КРИТИЧНО: Двойной `incrementFlagCount` — двойной ban
**Где:** §6.2 pseudo-код принятия решения, шаги 2 и 5.
**Проблема:**
```typescript
if (jailbreak.detect(text).matched) {
  await incrementFlagCount(userId, +1);   // шаг 2: +1
  return { ... };
}
// ... доходим до OpenAI moderation
await incrementFlagCount(userId, +1);     // шаг 5: ЕЩЁ +1
```
На самом деле в коде стоит `return` после jailbreak, так что дублирования нет. Но из текста описания неоднозначно. Также: **в шаге 5 нет проверки порогов после инкремента**. Если `flag_count_week >= USER_BAN_FLAG_THRESHOLD` — должны мгновенно поставить `banned_until`. В коде §6.2 этого вызова нет, только описание в JSDoc.
**Действие:** в `incrementFlagCount(userId)` сам метод проверяет порог и ставит ban (атомарно через SQL). Или явно в pseudo-коде после `incrementFlagCount` — `if (newCount >= threshold) await ban(userId, 24h)`.

---

### N2. КРИТИЧНО: `[AUDIT-C7]` сломан в §8.6 (group chat)
**Где:** §8.6 строка ~1880, `sink.commit(accumulated)`.
**Проблема:** В DM (§8.2) `commit()` использует `editMessageText` на typing-message. В группе `sink.commit(accumulated)` должен послать `reply_parameters: { message_id: ctx.message!.message_id }`. Сейчас в комментарии написано "sink.commit умеет в group reply через ctx.reply" — но как это передать в sink?
**Проблема №2:** `createTypingIndicatorSink({ ctx })` создаётся одинаково для DM и группы, но логика commit разная. Нужен флаг `replyToMessageId?: number` в опциях.
**Действие:** Расширить интерфейс sink:
```typescript
createTypingIndicatorSink({ ctx, replyToMessageId?: number })
```
В §8.6 — передавать `replyToMessageId: ctx.message!.message_id`.

---

### N3. ВЫСОКО: `voice.synthesize` в группе — typing-индикатор не работает
**Где:** §8.6, §8.2 шаг 12.
**Проблема:** `voice.synthesize(accumulated, ctx.lang)` после commit. Но в группе voice output не нужен (см. C12 первого аудита — отключаем в группах). В §8.6 этой проверки **нет** — будет звучать voice в группе если юзер в DM включил `voiceOutputEnabled`.
**Действие:** В §8.2 шаг 12: `if (user.voiceOutputEnabled && ctx.chat?.type === 'private' && ...)`. В §8.6 — вообще убрать voice.

---

### N4. ВЫСОКО: `getOrCreateActive` и `startNew` — race с partial unique index
**Где:** §5 (комментарий после `conversations` таблицы), §8.5 (persona switch), §8.7 (/new).
**Проблема:** Partial unique index `WHERE is_active=true AND group_chat_id IS NULL`. Но:
- `startNew` создаёт новую `(user_id, is_active=true, group_chat_id=NULL)` — **conflict** с существующей active conversation.
- `deactivateAllForUser` в §8.7 закрывает старые, потом `startNew` — но между этими двумя операциями параллельный `getOrCreateActive` может прочитать "нет активной" и создать вторую.
**Действие:** Обернуть в один transaction:
```sql
BEGIN;
UPDATE conversations SET is_active=false WHERE user_id=$1 AND is_active=true AND group_chat_id IS NULL;
INSERT INTO conversations(...) VALUES (..., is_active=true);
COMMIT;
```
В Drizzle — `db.transaction(async (tx) => { ... })`. Documented в `startNew` в JSDoc.

---

### N5. СРЕДНЕ: `incrementFlagCount` lazy reset не показан
**Где:** §6.2 JSDoc упоминает "+ lazy reset если неделя прошла", но имплементация не показана.
**Проблема:** Это атомарная операция (CAS в SQL), легко сделать неправильно — race между check и update.
**Действие:** Дать пример SQL в §6.2:
```sql
UPDATE users SET
  flag_count_week = CASE
    WHEN flag_count_week_reset_at < NOW() - INTERVAL '7 days' THEN 1
    ELSE flag_count_week + 1
  END,
  flag_count_week_reset_at = CASE
    WHEN flag_count_week_reset_at < NOW() - INTERVAL '7 days' THEN NOW()
    ELSE flag_count_week_reset_at
  END,
  flag_count_total = flag_count_total + 1
WHERE id = $1
RETURNING flag_count_week, flag_count_total;
```
Чтение `RETURNING` → if `flag_count_week >= 3` → set `banned_until` в **той же транзакции**.

---

## ⚠️ Закрыто частично — фикс упущен в одном месте

### P1. AUDIT-C7 (output moderation race) исправлен в §6.1b/§8.2, но в §9.1 и §10.2 описание flow осталось старое
**Где:**
- §10.2 (Content Safety pipeline на выходе): "То же самое, но на ответ модели. Если flagged — НЕ показывать юзеру" — но не уточнено что streaming идёт в hidden buffer.
- §9.1: "Tokens & cost: считать по полю `usage` в финальном чанке. Если поле отсутствует — оценить через tiktoken." — без ссылки на AUDIT-L13/H3, без указания "logging as degraded".
**Действие:** Добавить `[AUDIT-C7]` в §10.2 и `[AUDIT-L13]` в §9.1.

---

### P2. AUDIT-H1 (ffmpeg) — Dockerfile OK, но §9.4 не обновлён
**Где:** §9.4 (Edge-TTS) показывает `synthesize` возвращающий **MP3** — без конвертации в OGG.
**Проблема:** §6.4 написано правильно (через ffmpeg). §9.4 — старый пример из v1.0. Имплементатор может пойти по §9.4 и забыть про конвертацию.
**Действие:** Заменить §9.4 на пример **с конвертацией** (вызов `mp3ToOggOpus` из `utils/ffmpeg.ts`) и пометить `[AUDIT-H1]`.

---

### P3. AUDIT-H12 (категории mapping) исправлен в §6.2, но §10.1 — старая схема
**Где:** §10.1 (Content Safety pipeline на входе) использует имена `harm`, `violence`, `hate`, `self_harm`, `sexual`, `sexual/minors` — это смесь "внутренних" и "OpenAI raw". В коде после маппинга должно быть **только** `sexualMinors` (camelCase, без слеша).
**Действие:** Обновить ASCII-диаграмму §10.1 — использовать internal-имена (`sexualMinors`, `selfHarm`, etc.).

---

### P4. AUDIT-H11 (sexual/minors permaban) в §10.3 — старая формулировка
**Где:** §10.3 — "Sexual/minors категория → **сразу** `banned_permanent = TRUE`, без накопления"
**Проблема:** Не упомянуто что также admin alert + audit_log + критическая severity, и что это **до** инкремента счётчиков (защита от incrementFlagCount race).
**Действие:** Заменить bullet на полную формулировку из §6.2 / N1.

---

### P5. AUDIT-C9 (Privacy mode + reply-thread) — §16 acceptance, §14.3 чек-лист, §15 Неделя 5 — не обновлены
**Где:**
- §14.3 QA: "Reply на сообщение бота в группе → бот продолжает контекст" — **противоречит** §8.6 ("В MVP — single-turn для групп").
- §15 Неделя 5: "Group handler: @mention, reply to bot" + "Mapping group conversations (message_id → conversation_id)" + Acceptance "reply на ответ бота продолжает контекст".
- §5: остались поля `groupChatId` и `botMessageId` в conversations + index `idx_conversations_group_thread` — **уже не нужны** в MVP, но всё ещё в схеме.
**Действие:** 
- Убрать строку про "reply продолжает контекст" из §14.3 и §15.
- В §15 Неделя 5 — заменить "Mapping group conversations" на "Group single-turn handler". Убрать `saveGroupThread/getByGroupThread` из §6.9 ИЛИ пометить "только для Phase 2, в MVP не вызывается".
- Поля `groupChatId`/`botMessageId`/`idx_conversations_group_thread` в §5 — оставить (харм нулевой, поля nullable), но добавить комментарий "for Phase 2 reply-threads".

---

## ❗ Закрытые правильно — но есть скрытый багуй

### B1. AUDIT-L11 (cron jobs) — `resetDailyFlags` не имплементирован
**Где:** §12.4 `cron.schedule('0 0 * * *', ... costTracker.resetDailyFlags())`. §6.8 — `CostTracker.resetDailyFlags()` в интерфейсе.
**Проблема:** Что делает `resetDailyFlags`? §11.2 алерты дедуплицируются через `cost:alerted:${today}` с TTL 86400 — то есть **сам Redis** их сбросит. Что должен сбрасывать cron?
**Действие:** Уточнить в §6.8 что именно делает `resetDailyFlags`. Скорее всего — **ничего не нужно**, метод можно убрать (Redis TTL делает всё). Или: сбрасывать `kill_switch=1` (если был активирован за бюджет) — но это спорно, лучше не сбрасывать автоматически.

---

### B2. AUDIT-H10 (ToS version mismatch) — нет миграции для существующих users
**Где:** §8.1 шаг 2 — "if user.tos_version !== env.CURRENT_TOS_VERSION: reset tos_accepted_at = null".
**Проблема:** При первом запуске MVP — `CURRENT_TOS_VERSION='1.0'`. Юзер /start, accept → `tos_version='1.0'`. Если потом бампнуть до `'1.1'` — окей, юзер пере-акцептит. Но: **проверка `!== version` срабатывает и для существующих юзеров со старым `tos_version=null`** (которые были до v1.1 deployment). Но в MVP таких нет (первый запуск). Не баг сейчас, но **записать в Phase 1.1**: при бампе версии добавлять admin-команду для уведомления.
**Действие:** Документировать в README раздел "Bumping ToS version".

---

### B3. AUDIT-A1 (`/delete_my_data`) — anonymize audit_log?
**Где:** §8.9 — комментарий "audit_log (anonymize вместо удаления? по GDPR можно)".
**Проблема:** "anonymize?" — не решено. По GDPR — юзер имеет право на полное удаление (right to erasure). Audit_log для безопасности можно **частично** оставить (security exemption), но `userId` нужно anonymize.
**Действие:** Решить: либо **anonymize** (`userId=null`, `contentExcerpt='[deleted]'`, оставить categories+scores для статистики), либо **удалить** (проще, безопаснее с точки зрения GDPR). Рекомендация: **anonymize** — оставляем безопасность аудита, не теряем юридически чувствительную информацию о юзере.

---

### B4. AUDIT-L10 (/ready endpoint) — `pino-pretty` через pipe не работает в `docker compose up`
**Где:** §12.1 — "В dev — `pino-pretty` через **pipe** (`pnpm dev | pino-pretty`)"
**Проблема:** В docker-compose нельзя сделать pipe. Если кто-то запустит `docker compose up bot` для отладки — увидит JSON, не pretty. Это OK для prod, но напрягает в dev-Docker.
**Действие:** Документировать: `pino-pretty` только для local dev (без Docker). В docker-compose всегда JSON. Или: ставить `pino-pretty` как dep и пайпить внутри Docker через `sh -c "node dist/main.js | pino-pretty"`.

---

### B5. AUDIT-M11 (partial unique index) — конфликт с `bonusUpsert` в `startNew`
**Где:** §5 комментарий — `CREATE UNIQUE INDEX uniq_user_active_conv ON conversations(user_id) WHERE is_active = true AND group_chat_id IS NULL`.
**Проблема:** `startNew` в §8.5 / §8.7 не использует `ON CONFLICT` — будет ошибка unique violation. Транзакция нужна (см. N4).
**Действие:** В JSDoc `startNew` — указать что метод **транзакционно** деактивирует старые перед созданием.

---

## 🚫 НЕ исправлено (пункты первого аудита проигнорированы)

### Из критичных и высоких

#### C8 (старый): documents — что делать если active conversation с историей
**Статус:** ❌ Не закрыто. §8.4 шаг 6 как был `startNew(user.id)`. Не уточнено: спросить юзера или молча заменить?
**Действие:** В §8.4 добавить: "Старый conversation помечается inactive. Юзер видит `t('document.replaced_context')`."

#### C10 (старый): Webhook secret в Caddy
**Статус:** ✅ Caddyfile обновлён (`header_up X-Telegram-Bot-Api-Secret-Token`). Но **тест** не описан в §14.
**Действие:** Добавить integration test в §14.1: "POST /webhook без правильного secret → 401".

#### H4 (старый): rate limit инкрементируется даже при отказе
**Статус:** ❌ Не закрыто и не обсуждено. ТЗ молчит.
**Действие:** Документировать поведение в `RateLimiter` JSDoc: "Counter incremented even for rejected requests — protection against /spam".

#### H6 (старый): kill switch RTT на каждом update
**Статус:** ❌ Не оптимизировано. Принято, документировано.
**Действие:** ОК, не критично для MVP.

#### H7 (старый): voice rate limit при failed Whisper
**Статус:** ❌ Не обсуждено.
**Действие:** Добавить в §6.4/§8.3: "При Whisper failure — счётчик НЕ откатывается (защита от спама)".

#### H8 (старый): /report — на что
**Статус:** ✅ Решено в §8.8 (reply-to-bot или последний assistant).

### Из средних

#### M1: `noUncheckedIndexedAccess` + `!`
**Статус:** ✅ Документировано в "заметке имплементатору" (строка 43).

#### M2: `exactOptionalPropertyTypes` коллизии с grammY
**Статус:** ✅ Документировано (строка 44).

#### M3: pino-pretty alpine
**Статус:** ✅ Решено через pipe в dev.

#### M4: Drizzle relations
**Статус:** ❌ `src/db/relations.ts` упомянут в §3, но содержимое не показано.
**Действие:** Дать пример relations() для users↔conversations↔messages в §5.

#### M5: миграции в Docker entrypoint
**Статус:** ✅ Сделано (§13.0 CMD).

#### M6: pg_dump
**Статус:** ⚠️ Упомянуто в §15 Неделя 7, но **полная команда не приведена**.
**Действие:** Добавить в §13.5 (новый раздел) пример host crontab.

#### M7: utf8 mention extraction
**Статус:** ✅ Решено в §8.6 через `entities`.

#### M8: persona switch — старая conversation
**Статус:** ⚠️ Не решено явно. §8.5 callback вызывает `startNew` — но если уже active conversation есть, будет conflict с partial unique index (N4).
**Действие:** В §8.5 — добавить `await conversation.deactivateAllForUser(user.id)` перед `startNew`. Или сделать `startNew` транзакционным (см. N4).

#### M9: flag_count_week lazy reset
**Статус:** ⚠️ Упомянуто в §6.2 JSDoc, но SQL не показан (см. N5).

#### M10: document moderation 50K обход
**Статус:** ❌ Не закрыто.
**Действие:** Документировать ограничение в §8.4 шаг 5 + добавить metadata `doc_moderated_prefix_only` в audit log.

#### M11: partial unique index
**Статус:** ✅ Сделано в §5, **но** не обработан conflict в `startNew` (см. N4/B5).

#### M12: voice file size limit
**Статус:** ✅ Сделано (`MAX_VOICE_SIZE_MB`, §4 + §6.4).

#### M13: chatComplete
**Статус:** ❌ Только в интерфейсе. Use case не описан.
**Действие:** В §15 Неделя 2 — упомянуть: "реализовать chatComplete сразу, использование для auto-title в Phase 1.1".

#### M14: ar/zh rendering
**Статус:** ❌ Не упомянуто в §14.3 чек-листе как отдельный пункт.
**Действие:** Добавить в §14.3: "Полный флоу пройден в каждой из 6 локалей, включая inline keyboards".

#### M15: Whisper cache
**Статус:** ❌ Не упомянуто.
**Действие:** OK для MVP (см. risks в Приложении C — переход на whisper.cpp).

#### M16: AbortSignal привязка к user-action
**Статус:** ❌ Не упомянуто.
**Действие:** OK для MVP. /new во время streaming — ждёт окончания.

#### M17: report keyboard на каждом сообщении
**Статус:** ❌ В §8.2 шаг 8 убран `reply_markup: buildReportKeyboard()` (видимо принято решение). Но не задокументировано.
**Действие:** В §8.8 явно сказать "репорт через команду /report, не через inline кнопку".

### Из низких

#### L2: precision 12
**Статус:** ✅ Сделано в §5.

#### L3: bigserial deprecated
**Статус:** ❌ Оставлено (косметика).

#### L4: assert vs with
**Статус:** ✅ Сделано в §6.10.

#### L5: api.raw синтаксис
**Статус:** ⚠️ Не решено — но и `sendMessageDraft` теперь не используется в MVP (TypingIndicatorSink), вопрос неактуален.

#### L6: msedge-tts error handling
**Статус:** ❌ Не закрыто. §9.4 пример без try/catch.
**Действие:** Дать пример с error handling в §6.4 или §9.4.

#### L7: document handler логирование
**Статус:** ❌ Не упомянуто.
**Действие:** Документировать в §6.5 — что логировать.

#### L8: Caddyfile security headers
**Статус:** ✅ Сделано (§13.2).

#### L9: README в Неделе 1
**Статус:** ✅ Добавлено в acceptance Недели 1.

#### L10: /health vs /ready
**Статус:** ✅ Сделано (§13.0 healthcheck использует /ready).

#### L11: node-cron
**Статус:** ✅ Сделано (§12.4).

#### L12: trace_id
**Статус:** ✅ Сделано (§12.1).

#### L13: usage fallback
**Статус:** ✅ Сделано в §8.2 шаг 7.

#### L14: persona prompts на en, юзер ru
**Статус:** ❌ Не закрыто. Системные промпты остались на английском. Не критично.
**Действие:** В §6.6 `renderSystemPrompt` — добавить в финал `\n\nALWAYS respond in: ${userLang}`.

#### L15: InputFile синтаксис
**Статус:** ❌ Не проверено. В §8.2 шаг 12 — `new InputFile(voiceResult.value, 'response.ogg')`. Сигнатура может быть `InputFile({ source: buf, filename: 'response.ogg' })` в актуальной grammY.
**Действие:** Проверить в node_modules/@grammyjs/types.

#### L16: i18n fallback
**Статус:** ✅ Сделано (§6.10).

#### L17: vitest coverage threshold
**Статус:** ❌ Не добавлено.

#### L18: yaml reload
**Статус:** ❌ Не упомянуто.
**Действие:** Документировать "upsert по slug на startup" в README.

#### L19: ADMIN_CHAT_ID единственный
**Статус:** ❌ Один чат для всех алертов. OK для MVP.

#### L20: BACKLOG.md
**Статус:** ❌ Не создан.
**Действие:** Создать `BACKLOG.md` с §17 + риски + Phase 1.1 пункты.

### Из "отсутствует"

#### A2: /about содержимое
**Статус:** ⚠️ Текст в Приложении B минимальный, без версии бота / контакта.

#### A3: webhook secret генерация
**Статус:** ✅ Указано `openssl rand -hex 32` в `.env.example`.

#### A4: split >4000 chars
**Статус:** ✅ Сделано (§8.2 шаг 9 + utils/telegram-split.ts).

#### A5: контекст overflow
**Статус:** ✅ Сделано в §6.9 + §8.2 шаг 6.

#### A6: multi-instance
**Статус:** ❌ Не упомянуто.

#### A7: privacy policy
**Статус:** ✅ Решено через "включить в ToS".

#### A8: chat-flow integration test
**Статус:** ✅ Упомянуто в §14.2.

#### A9: webhook rate limit в Caddy
**Статус:** ❌ Не добавлено. OK для MVP (защита через secret token).

#### A10: deploy выделить в фазу
**Статус:** ❌ Не выделено. Неделя 7 по-прежнему перегружена (ToS + age gate + cost tracker + admin + cron + deploy + soft launch). **Это самый перегруженный спринт**.
**Действие:** Реально может занять 1.5-2 недели. Зарезервировать буфер.

---

## 🆕 Дополнительные находки v1.1

### X1. `messages.role` enum включает `'system'`, но никогда не используется
**Где:** §5 schema, §6.9 JSDoc.
**Проблема:** [AUDIT-C6] уточнено что system prompt не сохраняется в БД. Но enum `'system'` остаётся в schema без use case.
**Действие:** Либо убрать `'system'` из enum, либо документировать "reserved for Phase 2 (например, persona switch с system marker в истории)".

### X2. `services/streaming-sink.ts` — `createDraftStreamingSink` упоминается, но не используется в MVP
**Где:** §6.1b.
**Проблема:** Целая функция описана как "Phase 1.1 (post-MVP) имплементация". Но это лишний код в MVP-релизе.
**Действие:** Убрать из v1.1, оставить только `createTypingIndicatorSink`. `STREAMING_USE_DRAFT` env-флаг тоже убрать (нечем переключать).

### X3. `tokenizer: Tokenizer` тип не описан
**Где:** §6.5, §6.9 `createConversationService(deps: { tokenizer: Tokenizer; ... })`.
**Проблема:** Тип `Tokenizer` нигде не определён. js-tiktoken не экспортирует такого типа.
**Действие:** Определить в §6.0:
```typescript
export interface Tokenizer {
  estimate(text: string): number;        // приблизительная оценка
  // count() не делаем — для точности используем usage из gateway
}
```

### X4. `ctx.services.tokenizer.estimate(...)` в §8.2 — но tokenizer не указан в `ctx.services`
**Где:** §6.11 `CustomCtx.services` — нет `tokenizer`. Но §8.2 шаг 6 и 7 использует `ctx.services.tokenizer.estimate(...)`.
**Действие:** Добавить `tokenizer: Tokenizer` в `CustomCtx.services`.

### X5. `ctx.services.users.deleteCascade` в §8.9 — но `users` не в `ctx.services`
**Где:** §6.11 — нет `users`. §8.9 — `ctx.services.users.deleteCascade(user.id)`.
**Действие:** Решить: либо repositories в `ctx.services` (тогда добавить `users`, `userReports`, `conversation` repo), либо отдельно `ctx.repos.users` / `ctx.repos.userReports`. Чисто архитектурно — `services` для бизнес-логики, `repos` для доступа к данным. Введи `ctx.repos` или вынеси delete-логику в `usersService.deleteCascade`.

### X6. `ctx.services.userReports.create` в §8.8 — то же
**Где:** §8.8.
**Действие:** То же что X5.

### X7. `ctx.services.conversation.findMessageByTgId` и `lastAssistantMessage` — методы не описаны в интерфейсе
**Где:** §8.8.
**Проблема:** `ConversationService` интерфейс (§6.9) не содержит этих методов. Появились только в §8.8.
**Действие:** Добавить в §6.9 интерфейс:
```typescript
findMessageByTgId(userId: UserId, tgMessageId: number): Promise<MessageId | null>;
lastAssistantMessage(userId: UserId): Promise<MessageId | null>;
```
**Но**: `tgMessageId` — это Telegram message_id. В БД его **нет** в таблице `messages` (только `conversation_id`, `role`, `content`). То есть метод **не имплементируем** без миграции.
**Действие 2:** Добавить колонку `tg_message_id: bigint` в `messages` table.

### X8. `conversation.deactivateAllForUser` — метод не описан в интерфейсе
**Где:** §8.7 (handleNew).
**Действие:** Добавить в `ConversationService` интерфейс (§6.9).

### X9. `ctx.logger` и `ctx.traceId` — не в `CustomCtx`
**Где:** §12.1 `loggingMiddleware` пишет `ctx.logger = ...` и `ctx.traceId = ...`. Но `CustomCtx` (§6.11) этих полей не имеет.
**Действие:** Добавить в `CustomCtx`:
```typescript
logger: Logger;
traceId: string;
```

### X10. `app.ts` и `composer registration` — order не определён
**Где:** §3 структура — `bot/app.ts` упомянут. Но порядок middleware (auth → kill-switch → rate-limit → ...) — нигде не зафиксирован.
**Проблема:** Порядок важен — например, kill-switch должен идти **до** rate-limit (нет смысла инкрементить если бот в maintenance), но **после** logging (логировать все события). auth — раньше всех.
**Действие:** Добавить в §6.11 или новый §6.12 порядок middleware:
```
1. logging (trace_id, child logger)
2. auth (lookup user, проверка ban)
3. kill-switch (kill_switch redis check)
4. i18n (resolve lang)
5. (rate-limit делается в handler'е, не в middleware — per-kind)
```

### X11. ESM JSON imports — TS компилятор и Node compat
**Где:** §6.10 `import en from '../locales/en.json' with { type: 'json' }`.
**Проблема:** `tsc` с `module: NodeNext` поддерживает `with` начиная с TS 5.3. Node 22 поддерживает (флаг `--experimental-import-attributes` уже включён по умолчанию в 22.x). **Но**: `vitest` (esbuild-based) может не понимать `with` синтаксис, или Biome lint выдаст warning.
**Действие:** Проверить на pre-MVP smoke-тесте. Альтернатива (fallback) — `JSON.parse(await readFile(...))`.

### X12. `extractTextWithoutMention` — entity `bot_command` обрабатывается странно
**Где:** §8.6.
**Проблема:** В коде проверка `slice === @username` ИЛИ `slice.startsWith('/')` — то есть **любой** `/command` будет вырезан. Но что если юзер пишет `@bot /help как пройти?` — `/help` вырежется в составе текста.
**Действие:** Уточнить: вырезать `/command` только если он в начале (`offset === 0`) и без аргументов.

### X13. `findMessageByTgId` / `tg_message_id` — нужен в `appendMessage`
**Где:** Связано с X7.
**Проблема:** Если добавляем колонку `tg_message_id`, то `appendMessage` должен принимать её. И в §8.2 шаг 9 (commit) — мы знаем `firstMessageId` (Telegram message_id), его надо сохранить.
**Действие:** Расширить `appendMessage`:
```typescript
appendMessage(opts: {
  conversationId: ConversationId;
  role: ChatRole;
  content: string;
  tgMessageId?: number;       // Telegram's message_id (для /report)
  tokensInput?: number;
  tokensOutput?: number;
  costUsd?: number | null;
}): Promise<MessageId>;
```
И в §8.2 шаг 10 — передавать `tgMessageId: firstMessageId`.

### X14. `usageStatsDaily` — `voiceMessages` / `documents` инкремент не показан
**Где:** §11.2 `cost.trackRequest` инкрементит только `textMessages`. Но voice и document — тоже стоит.
**Действие:** Либо `trackRequest({ kind: 'text' | 'voice' | 'document', ... })`, либо отдельные методы `trackVoice`/`trackDocument`. В §6.8 интерфейсе уточнить.

### X15. `app.ts` использует `bot` глобально в `costTracker` (§11.2)
**Где:** §11.2 — `await bot.api.sendMessage(env.ADMIN_CHAT_ID, ...)`.
**Проблема:** `bot` — это grammY instance, должен быть инжектирован, а не быть глобалом. В §6.8 интерфейсе `bot: Bot` в deps есть. ОК. Но в pseudo-коде §11.2 используется без явного `deps.bot` — путает.
**Действие:** Уточнить в pseudo-коде `await deps.bot.api.sendMessage(...)`.

---

## ✅ Что закрыто хорошо

- C1 (streaming abstraction)
- C2/C3 (handlers vs composers, /lang)
- C4 (boolFromEnv) — особенно важно, **security fix**
- C5 (admin TG IDs refine)
- C7 (output moderation before show) — concept хороший
- H1 (ffmpeg в Docker)
- H2 (eventsource-parser)
- H3 (tiktoken только estimate, usage из gateway)
- H9 (age_rejected_at)
- H10 (ToS versioning через env)
- H11 (sexual/minors special case в moderation.ts)
- H12 (category mapping)
- L1 (compose version removed)
- L4 (with vs assert)
- L8 (security headers in Caddy)
- L9 (README в Неделе 1)
- L10 (/health + /ready)
- L11 (node-cron)
- L12 (traceId)
- L13 (usage fallback)
- A1 (/delete_my_data)
- A4 (split >4000)
- A5 (context overflow)
- A7 (privacy в ToS)

---

## Итог по v1.1

| Категория | v1.0 → v1.1 |
|-----------|-------------|
| Критичные | 10 → **3 новых (N1, N2 + старый C8/M11 race)** |
| Высокие | 12 → 1 новых (N3, N4) + 4 старых не закрыто |
| Средние | 17 → 1 новый (N5) + 9 старых не закрыто |
| Низкие | 20 → 8 старых не закрыто |
| Отсутствует | 10 → 3 не закрыто |
| Cross-ref / опечатки | новые: 15 (X1-X15) |

**Общая оценка v1.1:** документ **сильно улучшен** — основные security/UX дыры закрыты. Но появились **новые контрактные несоответствия** (X1-X15) — типы и сигнатуры в §6.x не совпадают с использованием в §8.x. Это починится за один проход рефакторинга, но критично сделать **до** старта Недели 1.

**Рекомендация перед стартом:**
1. Закрыть N1-N5 (5 новых критичных багов) — пере-фикс v1.2.
2. Пройти X1-X15 — синхронизировать интерфейсы и use cases.
3. Закрыть упущенные пункты M4, M8, M10, X7 (tg_message_id миграция).
4. Создать `BACKLOG.md` для пунктов отложенных в Phase 2.

После этого можно стартовать Неделю 1 безопасно.
