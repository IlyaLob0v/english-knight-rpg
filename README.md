# Knight of Words

Однопользовательская фэнтези-RPG для изучения английского: рыцарь побеждает врагов заданиями, отстраивает город модулями и «ремонтирует» здания интервальным повторением (FSRS). Архитектура и MVP-план: [Knight of Words: архитектура и MVP-план](https://claude.ai/artifact/UW5MMKcfwFNka3K2XvEszA).

Главное правило репозитория: **контент живёт отдельно от движка.** Модули, задания, порядок прохождения и привязка к зданиям лежат в `content/` как JSON со схемой; ни один пакет с кодом не содержит заданий.

## Структура

```
content/                 данные курса (правишь это, а не код)
  taxonomy/errors.json   словарь типов ошибок
  modules/*.json         модуль: тема, концепты (карточки FSRS), пул заданий, порог освоения
  tasks/*.json           задания модуля (choice, gap_fill, transform, order_words) с known_errors
  tracks/main.json       порядок модулей, главы, какое здание открывает модуль, босс
  world/*.json           здания и враги
packages/
  content/   @knight/content   JSON Schema, типы, валидатор (ссылки, циклы, дубли), сборка бандла
  learning/  @knight/learning  проверка ответа, классификатор ошибок, FSRS на концептах, патруль, журнал
  xapi/      @knight/xapi      профиль knight-v1, builder statement'ов, клиент LRS, outbox с повторами
apps/
  server/    @knight/server    шлюз: Content API, приём xAPI → LRS, LTI 1.3 (OIDC-запуск, AGS)
docs/adr/                       архитектурные решения
```

Игровой клиент (Phaser) появится в `apps/client` на неделе 3.

## Команды

```bash
pnpm install
pnpm content:validate   # проверить контент (то же самое делает CI)
pnpm content:bundle     # собрать dist/content-bundle.json
pnpm test               # все тесты
pnpm typecheck
pnpm check            # всё, что проверяет CI, одной командой
pnpm dev:server         # шлюз на http://localhost:8787 (настройки: apps/server/.env.example)
```

## Как менять курс без кода

- **Переставить модули или отдать здание другому модулю** — правка `content/tracks/main.json`. Валидатор не даст поставить модуль раньше его `prerequisites`.
- **Добавить задание** — запись в `content/tasks/<module>.json` и его id в `tasks` модуля. Убрать id из `tasks` — задание выключено, но не удалено.
- **Разметить новую типичную ошибку** — добавить `known_errors` в задание; тип ошибки должен быть в `taxonomy/errors.json`. Частые ответы `unclassified` из экрана статистики — главный источник таких правок.
- **Не переиспользуй** `task_id` и `concept_id`: по ним живут история xAPI и прогресс FSRS. При правке модуля повышай его `version`.

В VS Code схема подхватывается сама через поле `$schema` в каждом файле: автодополнение и подсветка ошибок прямо в редакторе.

## Интеграции

- **xAPI → LRS**: каждая попытка = statement `answered` с типом ошибки, концептом, временем и игровым контекстом. Actor — псевдонимный `account` (`player_id`), без email. Id statement'а = id попытки, поэтому повторная отправка из офлайн-очереди не создаёт дублей.
- **LTI 1.3**: `/lti/login` (OIDC), `/lti/launch` (проверка id_token), `/.well-known/jwks.json`. Сессия игры передаётся токеном в URL-фрагменте, не cookie, чтобы запуск работал в iframe Safari.
- **AGS**: `/progress/module-result` отправляет в журнал LMS лучший результат за модуль (одна строка журнала на модуль).
