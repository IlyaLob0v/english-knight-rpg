# Стенд LMS: Moodle, LRS и Postgres на своём компьютере

> **Заморожено с 27.10.2026** ([ADR 0008](adr/0008-moonbridge-platform.md)). Школа не работает в LMS; шлюз сохраняет LTI 1.3 и AGS на будущее. Игрового клиента рыцаря больше нет, поэтому шаги ниже, где ученик проходит бои, не выполнить до появления клиента платформы. Сквозной тест через Moodle можно запустить из тега `english-knight-v0.5`.

Этот стенд проверяет всю цепочку интеграции, как она будет работать со школой: игра открывается из курса Moodle по LTI 1.3, оценка за модуль приходит в журнал Moodle через AGS, каждая попытка уходит в LRS как xAPI statement, а состояние шлюза хранится в Postgres.

Нужны Docker (с `docker compose`), Node 22, pnpm и openssl. Порты: 5432 (Postgres), 8080 (Moodle), 8090 (LRS), 8787 (шлюз), 5173 (игра).

## Запуск

```bash
pnpm install
pnpm lms:up              # Postgres, LRS, Moodle; первый запуск ставит Moodle, 2–3 минуты
pnpm dev:server:lms      # шлюз с Postgres, LRS и Moodle (первый терминал)
pnpm dev:client          # игра (второй терминал)
```

`pnpm lms:up` (это `docker/setup.sh`) можно запускать повторно: он ничего не ломает и не дублирует. Что он делает:

1. Создаёт ключ инструмента LTI `docker/state/tool-key.pem` (один раз; Moodle проверяет им подпись шлюза).
2. Поднимает `compose.yaml`: Postgres с базами `moonbridge`, `moodle`, `lrsql`; Yet SQL LRS; Moodle 4.5 LTS.
3. Настраивает Moodle (`docker/moodle/provision.php`): регистрирует шлюз как инструмент LTI 1.3 с сервисом оценок, создаёт курс **KNIGHT**, ученика, учителя и по активности на каждый модуль из `content/tracks/main.json`.
4. Пишет настройки шлюза в `docker/state/gateway.env` и регистрацию Moodle в `docker/state/lti-platforms.json`.

Остановить: `pnpm lms:down` (данные остаются). Начать с нуля: `docker compose down -v` и снова `pnpm lms:up`.

## Как пройти вручную

1. Открой http://localhost:8080 и войди учеником: `student` / `Moonbridge-Student-1`.
2. Курс **Moonbridge (test course)** → активность **Moonbridge: Words at the Gate**. Игра откроется внутри страницы Moodle, без отдельного входа.
3. Пройди бои на первой точке карты и босса. Через несколько секунд после победы оценка появится в журнале: войди учителем (`teacher` / `Moonbridge-Teacher-1`) → курс → «Оценки».
4. Записи xAPI: админка LRS http://localhost:8090 (`admin` / `moonbridge-admin`) или из терминала:

```bash
pnpm lrs:errors verb_to_be.negative             # ошибки по концепту за 7 дней
pnpm lrs:errors past_simple.irregular --days 30 --json
```

Администратор Moodle: `admin` / `Moonbridge-Admin-1`. Все пароли стенда — только для локальной проверки.

## Автотест всей цепочки

При запущенных `pnpm lms:up`, `pnpm dev:server:lms` и `pnpm dev:client`:

```bash
pnpm e2e:lms             # HEADED=1 pnpm e2e:lms, чтобы смотреть в окне браузера
```

Тест заводит в Moodle нового ученика, запускает игру из активности, проходит три боя (два из них без сети) и босса, затем проверяет:

- оценка 100 в колонке модуля в журнале Moodle не позже чем через минуту после победы;
- в LRS каждая попытка ровно один раз, хотя часть боёв шла офлайн, и повторная отправка той же очереди не создаёт дублей;
- запрос «ошибки по концепту за неделю» возвращает именно те ошибки, которые сделал тест;
- во втором браузере (другое устройство) игрок находит модуль освоенным: прогресс восстановился с сервера.

То же самое запускает CI (`.github/workflows/lms-e2e.yml`) на каждом PR, который трогает код, контент или стенд. Если тест упал, снимок экрана лежит в `e2e/.artifacts/failure.png`, в CI — в артефакте `lms-e2e` вместе с логами.

## Что где хранится

| Что | Где | Зачем |
|---|---|---|
| Связь пользователя LMS (`iss`, `sub`) с игроком | Postgres `lti_identities` | один человек — один `player_id` во всех запусках |
| Состояние OIDC-входа | Postgres `lti_login_states` | запуск не ломается при перезапуске шлюза |
| Лучший балл модуля | Postgres `module_scores` | в журнал уходит только лучший результат |
| Оценки на пути в LMS | Postgres `grade_outbox` | при сбое Moodle оценка ждёт и уходит позже |
| xAPI на пути в LRS | Postgres `xapi_outbox` | при сбое LRS записи ждут; повтор не создаёт дублей |
| Копия прогресса игрока | Postgres `player_progress` | город на другом устройстве |
| Все попытки и ошибки | LRS | аналитика: ошибки по концептам, типам, времени |
| Итоговая оценка за модуль | журнал Moodle | то, что видит учитель |

Проверить очереди: `docker compose exec postgres psql -U postgres -d moonbridge -c "SELECT status, count(*) FROM grade_outbox GROUP BY 1"` (то же для `xapi_outbox`). Строки `failed` и `dead` — то, что не ушло после всех повторов, в `last_error` причина.

## Подключение настоящей LMS школы

Стенд использует адреса, которые работают только на одной машине. Для настоящего Moodle (или другой LMS с LTI 1.3 и AGS):

1. Разверни шлюз по публичному HTTPS-адресу (например `https://game.school.example`) с Postgres (`DATABASE_URL`), постоянным ключом (`LTI_PRIVATE_KEY` или `LTI_PRIVATE_KEY_FILE`, ключ — `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048`) и `NODE_ENV=production`.
2. В Moodle: «Администрирование → Плагины → Внешний инструмент → Управление инструментами → Настроить инструмент вручную»:
   - версия LTI: **LTI 1.3**; тип открытого ключа: **Keyset URL**;
   - Tool URL и Redirection URI: `https://game.school.example/lti/launch`;
   - Initiate login URL: `https://game.school.example/lti/login`;
   - Public keyset: `https://game.school.example/.well-known/jwks.json`;
   - «Службы → Оценки IMS LTI»: **«Использовать эту службу для синхронизации оценок и управления столбцами»**;
   - «Конфиденциальность → Принимать оценки от инструмента»: **Всегда**; имя и email передавать не нужно.
3. После сохранения Moodle покажет Platform ID, Client ID, Deployment ID и адреса. Передай их шлюзу в `LTI_PLATFORMS` (или файлом `LTI_PLATFORMS_FILE`):

```json
[{
  "issuer": "https://moodle.school.example",
  "clientId": "<Client ID>",
  "deploymentIds": ["<Deployment ID>"],
  "authLoginUrl": "https://moodle.school.example/mod/lti/auth.php",
  "authTokenUrl": "https://moodle.school.example/mod/lti/token.php",
  "jwksUrl": "https://moodle.school.example/mod/lti/certs.php"
}]
```

4. В курсе добавь активность «Внешний инструмент» на каждый модуль и укажи в «Дополнительные параметры» `module_id=<id модуля>`, например `module_id=A1_PastSimple_01`. Без параметра игра откроется целиком, а оценки модулей лягут в отдельные колонки, которые шлюз создаст сам.
5. LRS для школы — отдельный экземпляр (SQL LRS или любой xAPI 1.0.3 LRS) в юрисдикции учеников; шлюзу нужны `LRS_ENDPOINT`, `LRS_KEY`, `LRS_SECRET`. В LRS попадает только псевдоним `player_id`, имена и email остаются в LMS.

## Если что-то не работает

- **«unknown platform» при запуске** — шлюз запущен без `LTI_PLATFORMS`; для стенда используй `pnpm dev:server:lms`, а не `pnpm dev:server`.
- **Оценка не появляется** — посмотри `grade_outbox.last_error`. `invalid_client` или ошибка подписи значит, что Moodle не достучался до `/.well-known/jwks.json` шлюза или ключ сменился: на стенде шлюз должен слушать `0.0.0.0:8787` (по умолчанию так и есть).
- **Moodle долго не поднимается** — первый запуск ставит базу; `docker compose logs -f moodle`.
- **Порт занят** — поменяй левую часть в `ports` в `compose.yaml` и `SITE_URL` у Moodle (тогда `docker compose down -v` и `pnpm lms:up`).
