import { createContext } from "preact";
import { useCallback, useContext, useEffect, useState } from "preact/hooks";
import type { ComponentChild } from "preact";

/**
 * UI localization.
 *
 * Keys are the English source strings, so a missing translation degrades to
 * correct English rather than a bare key — and the English "dictionary" only
 * needs the entries whose shape differs (plurals). Ukrainian is the first
 * additional language; the list is `LANGS`.
 *
 * The **native menu** (menu.rs) is intentionally not localized: rebuilding it
 * on a language switch means threading every label through IPC and re-running
 * the menu rebuild machinery that exists for favorites — left for a later
 * pass, not silently half-done.
 */

export type Lang = "en" | "ua";

export const LANGS: { value: Lang; label: string }[] = [
  { value: "en", label: "English" },
  { value: "ua", label: "Українська" },
];

const STORAGE_KEY = "pyshell.lang";

/** The plural slot a count falls into. Slavic rules: Ukrainian needs all
 * three; English only distinguishes one/other, and its `few` entries are
 * simply absent so they fall through to `many`. */
export type PluralSlot = "one" | "few" | "many";

export interface PluralForms {
  one?: string;
  few?: string;
  many: string;
}

type Entry = string | PluralForms;
type Dictionary = Record<string, Entry>;

/** English entries whose shape differs from the key: plurals. */
const en: Dictionary = {
  "{n} scripts": { one: "{n} script", many: "{n} scripts" },
  "{n} files": { one: "{n} file", many: "{n} files" },
  "{n} errors": { one: "{n} error", many: "{n} errors" },
  "{n} fields need attention": { one: "{n} field needs attention", many: "{n} fields need attention" },
  "{n} fields changed": { one: "{n} field changed", many: "{n} fields changed" },
  "{n} dependencies installed": {
    one: "{n} dependency installed",
    many: "{n} dependencies installed",
  },
  "{n} other scripts running": {
    one: "{n} other script running",
    many: "{n} other scripts running",
  },
  "{n} updates available": { one: "{n} update available", many: "{n} updates available" },
  "Exported {n} runs": { one: "Exported {n} run", many: "Exported {n} runs" },
  "{n} rows": { one: "{n} row", many: "{n} rows" },
  "{m} not installed (select it for details)": {
    one: "{m} not installed (select it for details)",
    many: "{m} not installed (select it for details)",
  },
};

/** Ukrainian translations, keyed by the English source string. */
const ua: Dictionary = {
  // --- Sidebar / general chrome --------------------------------------------
  "Scripts": "Скрипти",
  "+ Folder": "+ Тека",
  "+ File": "+ Файл",
  "+ Store": "+ Store",
  "Import a folder with pyshell.yaml": "Імпортувати теку з pyshell.yaml",
  "Import a single .py file": "Імпортувати окремий .py-файл",
  "Download a script from the PyShell-scripts repo": "Завантажити скрипт із репозиторію PyShell-scripts",
  "{n} updates available": {
    one: "Доступне {n} оновлення",
    few: "Доступні {n} оновлення",
    many: "Доступно {n} оновлень",
  },
  "Favorites": "Обране",
  "Other": "Інше",
  "Search…": "Пошук…",
  "Clear search": "Очистити пошук",
  "Sort A→Z": "Сортувати А→Я",
  "Sorted A→Z — click for import order": "Відсортовано А→Я — клікніть для порядку імпорту",
  "Sort scripts alphabetically": "Сортувати скрипти за алфавітом",
  "Loading…": "Завантаження…",
  "No scripts yet. Use": "Ще немає скриптів. Використовуйте",
  "for a project with a": "для проєкту з",
  "or": "або",
  "for a single script.": "для окремого скрипта.",
  "Need something to run?": "Потрібно щось запустити?",
  "— ready-made scripts from": "— готові скрипти з",
  "No scripts match \"{q}\".": "Скриптів за запитом «{q}» немає.",
  "Recently imported paths": "Нещодавно імпортовані шляхи",
  "Script Store — {n} updates available": "Script Store — доступні оновлення: {n}",
  "{n} runs in progress": {
    one: "{n} запуск виконується",
    few: "{n} запуски виконуються",
    many: "{n} запусків виконується",
  },
  "Settings (⌘,)": "Налаштування (⌘,)",
  "Settings (⌘,) — a PyShell update is available": "Налаштування (⌘,) — доступне оновлення PyShell",
  "Running": "Виконується",
  "File is missing — click Find to relink": "Файл відсутній — клікніть «Знайти», щоб перелінкувати",
  "Find": "Знайти",
  "Find file": "Знайти файл",
  "Depends on {n} scripts": {
    one: "Залежить від {n} скрипта",
    few: "Залежить від {n} скриптів",
    many: "Залежить від {n} скриптів",
  },
  "{m} not installed (select it for details)": {
    one: "{m} не встановлено (виберіть скрипт, щоб дізнатись більше)",
    few: "{m} не встановлено (виберіть скрипт, щоб дізнатись більше)",
    many: "{m} не встановлено (виберіть скрипт, щоб дізнатись більше)",
  },
  "all installed": "усі встановлені",
  "Select with ⌘{n}": "Вибрати через ⌘{n}",
  "Unpin from Favorites": "Відкріпити з обраного",
  "Pin to Favorites": "Закріпити в обраному",
  "Pin to Favorites (⇧⌘F)": "Закріпити в обраному (⇧⌘F)",
  "Unpin {name}": "Відкріпити {name}",
  "Pin {name}": "Закріпити {name}",
  "Remove {name}": "Видалити {name}",
  "Remove script": "Видалити скрипт",
  "Remove script?": "Видалити скрипт?",
  "This removes the script from PyShell and deletes its virtual environment, presets, history and stored secrets. The script file on disk is not touched.":
    "Це вилучає скрипт із PyShell та видаляє його віртуальне середовище, пресети, історію і збережені секрети. Файл скрипта на диску не зникає.",
  "Refresh": "Оновити",
  "Copied {path}": "Скопійовано {path}",
  "Copy path failed": "Не вдалося скопіювати шлях",
  "Open in PyCharm failed": "Не вдалося відкрити в PyCharm",
  "Open in Terminal failed": "Не вдалося відкрити в Terminal",
  "Relink failed": "Не вдалося перелінкувати",
  "Remove failed": "Не вдалося видалити",

  // --- Script actions -------------------------------------------------------
  "Copy path": "Копіювати шлях",
  "Open in PyCharm": "Відкрити в PyCharm",
  "Open in Terminal": "Відкрити в Terminal",
  "Show in Finder": "Показати у Finder",
  "Refresh metadata": "Оновити метадані",
  "Pin": "Закріпити",
  "Unpin": "Відкріпити",
  "Pin / Unpin": "Закріпити / відкріпити",
  "Duplicate": "Дублювати",
  "Script duplicated": "Скрипт здубльовано",
  "Export presets…": "Експортувати пресети…",
  "This script has no presets to export": "У цього скрипта немає пресетів для експорту",
  "Exported {n} presets": {
    one: "Експортовано {n} пресет",
    few: "Експортовано {n} пресети",
    many: "Експортовано {n} пресетів",
  },
  "Imported {n} presets": {
    one: "Імпортовано {n} пресет",
    few: "Імпортовано {n} пресети",
    many: "Імпортовано {n} пресетів",
  },
  "Invalid presets file": "Некоректний файл пресетів",
  "Import presets…": "Імпортувати пресети…",
  "Rebuild env": "Перебудувати середовище",
  "Remove…": "Видалити…",
  "Remove": "Видалити",
  "Delete": "Видалити",
  "Cancel": "Скасувати",
  "Close": "Закрити",
  "Save": "Зберегти",
  "Rename": "Перейменувати",
  "Rename…": "Перейменувати…",
  "Load": "Завантажити",
  "Retry": "Повторити",
  "Compare": "Порівняти",
  "Log": "Лог",
  "Files": "Файли",
  "Run": "Запустити",
  "Run again": "Запустити знову",
  "Run again with the same values (⌘↩)": "Запустити знову з тими самими значеннями (⌘↩)",
  "Reset": "Скинути",
  "Reset all fields to schema defaults": "Скинути всі поля до значень за замовчуванням",
  "Preview": "Прев'ю",
  "Preview the command line that will be executed": "Переглянути командний рядок, який буде виконано",
  "Prepare Env": "Підготувати середовище",
  "Preparing…": "Підготовка…",
  "Prepare the environment first": "Спочатку підготуйте середовище",
  "Fix the highlighted fields first": "Спочатку виправте підсвічені поля",
  "Run the script (⌘↩)": "Запустити скрипт (⌘↩)",
  "Stop the run (⌘.)": "Зупинити запуск (⌘.)",
  "Introspect": "Інтроспекція",
  "Introspecting…": "Інтроспекція…",
  "Run introspection": "Запустити інтроспекцію",
  "Save Manifest": "Зберегти маніфест",
  "Show Code": "Показати код",
  "Docs": "Документація",
  "Show": "Показати",
  "Hide": "Сховати",
  "Reload": "Перечитати",
  "Re-read the manifest from disk": "Перечитати маніфест із диска",
  "Manifest error": "Помилка маніфеста",
  "Guessed": "Вгадано",
  "Script version": "Версія скрипта",
  "Schema inferred from PEP 723 metadata": "Схема виведена з метаданих PEP 723",
  "No manifest found — schema is a bare fallback": "Маніфеста не знайдено — схема це мінімальний фолбек",
  "Fields were guessed from PEP 723 metadata. Introspection reads the script's real arguments.":
    "Поля вгадано з метаданих PEP 723. Інтроспекція зчитає справжні аргументи скрипта.",
  "No manifest found — the form below is a bare fallback. Introspection reads the script's real arguments.":
    "Маніфеста не знайдено — форма нижче це мінімальний фолбек. Інтроспекція зчитає справжні аргументи скрипта.",
  "This script will be killed after {n}s unless it exits first": "Скрипт буде завершено через {n} с, якщо він не завершиться сам",
  "Needs: {id}": "Потребує: {id}",
  "Needs: {n} scripts": "Потребує: {n} скриптів",
  "{n} other scripts running": {
    one: "{n} інший скрипт виконується у фоні",
    few: "{n} інші скрипти виконуються у фоні",
    many: "{n} інших скриптів виконується у фоні",
  },
  "This script expects other scripts to be installed: {list}. Install them from the Store (+ Store) — installed ones are passed to it as PYSHELL_DEPS.":
    "Цей скрипт очікує встановлених інших скриптів: {list}. Встановіть їх зі Store (+ Store) — встановлені передаються йому через PYSHELL_DEPS.",
  "{n} running": {
    one: "{n} виконується",
    few: "{n} виконуються",
    many: "{n} виконуються",
  },
  "Active jobs ({count})": "Активні запуски ({count})",
  "current": "поточний",

  // --- Panes / tabs ---------------------------------------------------------
  "Parameters": "Параметри",
  "Output": "Вивід",
  "Results": "Результати",
  "History": "Історія",
  "Auto-scroll": "Автопрокрутка",
  "No output yet": "Виводу ще немає",
  "Press Run — stdout and stderr stream in live.": "Натисніть «Запустити» — stdout і stderr з'являтимуться наживо.",
  "All": "Усе",
  "Search output…": "Пошук у виводі…",
  "Wrap": "Переносити",
  "Copy": "Копіювати",
  "Export": "Експорт",
  "Wrapping long lines — click to truncate": "Довгі рядки переносяться — клікніть, щоб обрізати",
  "Truncating long lines — click to wrap": "Довгі рядки обрізаються — клікніть, щоб переносити",
  "No runs yet.": "Запусків ще не було.",
  "No runs match \"{q}\".": "Запусків за запитом «{q}» немає.",
  "Search runs…": "Пошук запусків…",
  "Search history": "Пошук в історії",
  "Export history…": "Експортувати історію…",
  "Export history as CSV": "Експортувати історію як CSV",
  "Export history as JSON": "Експортувати історію як JSON",
  "Exported {n} runs": {
    one: "Експортовано {n} запуск",
    few: "Експортовано {n} запуски",
    many: "Експортовано {n} запусків",
  },
  "This script takes no parameters.": "Цей скрипт не приймає параметрів.",
  "No script selected": "Скрипт не вибрано",
  "Pick one from the sidebar, or import a new script to get started.": "Виберіть скрипт у сайдбарі або імпортуйте новий.",
  "Succeeded": "Успіх",
  "Failed": "Помилка",
  "exit {code}": "вихід {code}",
  "Reveal this run's log in Finder": "Показати лог цього запуску у Finder",
  "Open this run's output folder": "Відкрити теку виводу цього запуску",
  "Re-run with these values": "Перезапустити з цими значеннями",
  "Select for comparison": "Вибрати для порівняння",
  "Cancel comparison": "Скасувати порівняння",
  "Compare with this run": "Порівняти з цим запуском",
  "Run comparison": "Порівняння запусків",
  "Base:": "База:",
  "Target:": "Ціль:",
  "No differences — both runs used the same values.": "Відмінностей немає — обидва запуски мали однакові значення.",
  "{n} fields changed": {
    one: "{n} поле змінилося",
    few: "{n} поля змінилися",
    many: "{n} полів змінилося",
  },

  // --- Presets --------------------------------------------------------------
  "Presets": "Пресети",
  "None saved yet": "Ще не збережено",
  "New preset…": "Новий пресет…",
  "Load this preset": "Завантажити цей пресет",
  "Loaded": "Завантажено",
  "Loaded — modified": "Завантажено — змінено",
  "Modified": "Змінено",
  "Rename preset": "Перейменувати пресет",
  "Deleted preset \"{name}\"": "Пресет «{name}» видалено",

  // --- Env / status ---------------------------------------------------------
  "✓ Ready ({size} MB)": "✓ Готове ({size} МБ)",
  "⚠ Needs setup": "⚠ Потрібне налаштування",
  "⚠ Stale — needs rebuild": "⚠ Застаріле — потрібна перебудова",
  "Building… {pct}%": "Збирання… {pct}%",
  "✗ {message}": "✗ {message}",
  "{n} errors": {
    one: "{n} помилка",
    few: "{n} помилки",
    many: "{n} помилок",
  },
  "{n} fields need attention": {
    one: "{n} поле потребує уваги",
    few: "{n} поля потребують уваги",
    many: "{n} полів потребують уваги",
  },
  "PyShell {version} is available": "Доступний PyShell {version}.",
  "Environment not set up. Click Prepare Env to create an isolated venv.": "Середовище не налаштовано. Натисніть «Підготувати середовище», щоб створити ізольований venv.",
  "Environment is stale: {reason}. Rebuild required.": "Середовище застаріло: {reason}. Потрібна перебудова.",
  "Environment failed: {message}": "Помилка середовища: {message}",
  "Building environment… {pct}%": "Збирання середовища… {pct}%",
  "Environment ready": "Середовище готове",
  "Creating virtual environment...": "Створення віртуального середовища…",
  "Installing dependencies...": "Встановлення залежностей…",
  "Running…": "Виконується…",
  "Progress": "Прогрес",

  // --- Dialogs ---------------------------------------------------------------
  "Run Introspection?": "Запустити інтроспекцію?",
  "Run Introspection": "Запустити інтроспекцію",
  "PyShell will execute this script to detect its arguments. This runs all code at the module top-level — imports, function definitions, and any code outside if __name__. A 10-second timeout is enforced. No secrets are passed.":
    "PyShell виконає цей скрипт, щоб визначити його аргументи. Це запускає весь код верхнього рівня модуля — імпорти, визначення функцій і будь-який код поза if __name__. Діє 10-секундний тайм-аут. Секрети не передаються.",
  "Cancel run": "Скасувати запуск",
  "Cancel this run?": "Скасувати цей запуск?",
  "Keep running": "Не зупиняти",
  "The script and all its child processes will be killed immediately. Any partial output is kept in the log.":
    "Скрипт і всі його дочірні процеси буде негайно завершено. Частковий вивід залишиться в лозі.",
  "Install Dependencies?": "Встановити залежності?",
  "Install": "Встановити",
  "The following packages will be installed in an isolated virtual environment:": "Ці пакети буде встановлено в ізольоване віртуальне середовище:",
  "Only pre-built wheels are used when available. Building from source (sdist) is supported as fallback for Python 3.13+.":
    "Якщо можливо, використовуються готові wheels. Збирання з вихідників (sdist) підтримується як фолбек для Python 3.13+.",
  "Script Code": "Код скрипта",
  "This is the code that will be executed during introspection. Review it before proceeding.": "Цей код буде виконано під час інтроспекції. Перегляньте його, перш ніж продовжити.",
  "Welcome to PyShell": "Вітаємо в PyShell",
  "PyShell runs Python scripts in isolated virtual environments. To prepare environments and install dependencies, the app needs network access to download Python interpreters and packages via uv.":
    "PyShell запускає Python-скрипти в ізольованих віртуальних середовищах. Щоб готувати середовища й встановлювати залежності, застосунку потрібен доступ до мережі — завантажувати інтерпретатори Python і пакети через uv.",
  "Scripts run locally on your machine with full system access (no sandbox). Import only scripts you trust.":
    "Скрипти виконуються локально на вашій машині з повним доступом до системи (без пісочниці). Імпортуйте лише ті скрипти, яким довіряєте.",
  "Need something to run? The + Store button in the sidebar installs ready-made scripts from the community repo.":
    "Потрібно щось запустити? Кнопка «+ Store» у сайдбарі встановлює готові скрипти зі спільнотного репозиторію.",
  "Got it": "Зрозуміло",
  "Browse the Store": "Переглянути Store",
  "How to Write a Script": "Як написати скрипт",
  "Ready-made scripts to import and learn from:": "Готові скрипти, які можна імпортувати й вчитися на них:",

  // --- Store ------------------------------------------------------------------
  "Script Store": "Store скриптів",
  "Search the store…": "Пошук у Store…",
  "Choose a destination folder…": "Виберіть теку призначення…",
  "Choose…": "Вибрати…",
  "Download scripts into this folder": "Завантажити скрипти в цю теку",
  "Choosing the destination failed": "Не вдалося вибрати теку призначення",
  "Downloading {done}/{total}…": "Завантаження {done}/{total}…",
  "Starting…": "Початок…",
  "Installed": "Встановлено",
  "Installed {name}": "Встановлено: {name}",
  "Install failed": "Не вдалося встановити",
  "{n} dependencies installed": {
    one: "ще {n} залежність",
    few: "ще {n} залежності",
    many: "ще {n} залежностей",
  },
  "Update": "Оновити",
  "Update {name}?": "Оновити {name}?",
  "Update failed": "Не вдалося оновити",
  "Updated {name} — the previous folder is kept as a .backup beside it":
    "Оновлено: {name} — попередня тека залишається як .backup поруч",
  "Repair": "Відновити",
  "Repair {name}?": "Відновити {name}?",
  "Repair failed": "Не вдалося відновити",
  "Repaired {name} — the previous folder is kept as a .backup beside it":
    "Відновлено: {name} — попередня тека залишається як .backup поруч",
  "Uninstall": "Видалити",
  "Uninstall {name}?": "Видалити {name}?",
  "Uninstall failed": "Не вдалося видалити",
  "Uninstalled {name}": "Видалено: {name}",
  "The script is removed from the list along with its virtual environment, presets, run history and stored secrets. The folder itself stays on disk — delete it by hand if you want it gone.":
    "Скрипт буде вилучено зі списку разом із віртуальним середовищем, пресетами, історією запусків і збереженими секретами. Сама тека залишається на диску — видаліть її вручну, якщо потрібно.",
  "The script's folder will be replaced with the repo's current version{version}. Your presets, history and secrets are kept; the environment rebuilds if its dependencies changed. The current folder — including any local edits — is kept as a .backup beside the new one.":
    "Теку скрипта буде замінено на поточну версію з репозиторію{version}. Пресети, історія та секрети зберігаються; середовище перебудується, якщо змінилися залежності. Поточна тека — включно з локальними правками — залишиться як .backup поруч із новою.",
  "The folder's files are re-downloaded from the repo, replacing whatever is there now — useful when files were corrupted or edited by mistake. Presets, history and secrets are kept; the current folder is kept as a .backup beside the new one.":
    "Файли теки буде повторно завантажено з репозиторію поверх тих, що там зараз, — корисно, коли файли пошкоджені або випадково змінені. Пресети, історія та секрети зберігаються; поточна тека залишиться як .backup поруч із новою.",
  "Re-download the folder from the repo, replacing the current files (kept as a .backup)":
    "Повторно завантажити теку з репозиторію, замінивши поточні файли (стара тека залишиться як .backup)",
  "Remove the script, its environment, presets, history and secrets":
    "Видалити скрипт, його середовище, пресети, історію та секрети",
  "Missing folder": "Тека відсутня",
  "update available": "доступне оновлення",
  "Loading the catalog from GitHub…": "Завантаження каталогу з GitHub…",
  "No scripts found in the repo.": "У репозиторії немає скриптів.",
  "Nothing matches \"{q}\".": "Нічого не знайдено за запитом «{q}».",
  "Refresh catalog": "Оновити каталог",
  "Re-fetch the catalog from GitHub (spends one API request)": "Повторно завантажити каталог з GitHub (витрачає один API-запит)",
  "needs": "потребує",
  "Installed automatically alongside this script": "Встановлюється автоматично разом із цим скриптом",
  "Imported, but the script's folder is gone. Relink it with Find on its row in the sidebar — that keeps presets and history; removing and reinstalling would not.":
    "Імпортований, але тека скрипта зникла. Перелінкуйте його через «Знайти» в сайдбарі — це збереже пресети й історію; видалення й повторне встановлення — ні.",
  "Download into {path} and import": "Завантажити в {path} та імпортувати",
  "Choose a destination folder first": "Спочатку виберіть теку призначення",
  "A job of this script is running — stop it before updating":
    "Запуск цього скрипта виконується — зупиніть його перед оновленням",
  "Replace the installed folder with v{version} from the repo":
    "Замінити встановлену теку на v{version} з репозиторію",
  "Already imported — its id is in your script list":
    "Вже імпортований — його id є у вашому списку скриптів",
  "Scripts are downloaded from the community repo and imported like a local folder. They run with your permissions — review the code before running it.":
    "Скрипти завантажуються зі спільнотного репозиторію та імпортуються як локальна тека. Вони виконуються з вашими правами — перегляньте код перед запуском.",
  "{n} scripts": { one: "{n} скрипт", few: "{n} скрипти", many: "{n} скриптів" },

  // --- Settings -----------------------------------------------------------------
  "Settings": "Налаштування",
  "Appearance": "Вигляд",
  "Choose how PyShell looks. \"Match system\" follows your OS setting.":
    "Виберіть, як виглядає PyShell. «Як у системі» слідкує за налаштуванням ОС.",
  "Theme": "Тема",
  "Light": "Світла",
  "Dark": "Темна",
  "Match system": "Як у системі",
  "Colour theme": "Колірна тема",
  "Language": "Мова",
  "Interface language. The native menu bar stays in English for now.":
    "Мова інтерфейсу. Рідне меню застосунку поки що залишається англійською.",
  "Storage": "Сховище",
  "virtual environments, caches and run output": "віртуальні середовища, кеші та вивід запусків",
  "Envs are kept in Application Support, not next to your scripts. Reclaim removes orphans (scripts no longer imported) and stale environments left by changed requirements.":
    "Середовища зберігаються в Application Support, а не поруч зі скриптами. «Звільнити» видаляє зайві (скрипти, які більше не імпортовані) та застарілі середовища після зміни залежностей.",
  "Reclaimed {size}": "Звільнено {size}",
  "{size} of orphaned environments can be reclaimed.": "Можна звільнити {size} зайвих середовищ.",
  "Environment deleted — click Prepare Env to rebuild": "Середовище видалено — натисніть «Підготувати середовище», щоб перебудувати",
  "Delete this script's virtual environment": "Видалити віртуальне середовище цього скрипта",
  "Reclaim": "Звільнити",
  "Reclaiming…": "Звільнення…",
  "Reclaim orphans": "Звільнити зайве",
  "Per-script environments": "Середовища за скриптами",
  "No environments on disk.": "На диску немає середовищ.",
  "Total": "Разом",
  "Envs": "Середовища",
  "uv cache": "кеш uv",
  "History & limits": "Історія та ліміти",
  "how much PyShell keeps, and for how long": "скільки PyShell зберігає і наскільки довго",
  "Runs kept per script": "Запусків зберігається на скрипт",
  "Both the History list and the run folders on disk are trimmed to this many entries per script, so Log and Files always work for what History shows. Applies the next time a run finishes. {min}–{max}.":
    "І список Історії, і теки запусків на диску обрізаються до цієї кількості на скрипт, тож кнопки «Лог» і «Файли» завжди працюють для того, що показує Історія. Застосовується при наступному завершенні запуску. {min}–{max}.",
  "Per-run output is capped at 50 MB / 500k lines — beyond that, the head and the tail are kept and the skipped middle is bannered. The full log is always on disk.":
    "Вивід одного запуску обмежено 50 МБ / 500 тис. рядків — далі зберігаються початок і кінець, а пропущена середина позначається в логу. Повний лог завжди є на диску.",
  "The Store catalog is re-checked from GitHub at most every 5 minutes.":
    "Каталог Store повторно перевіряється з GitHub не частіше ніж раз на 5 хвилин.",
  "The app-update check runs at most every 6 hours.":
    "Перевірка оновлень застосунку виконується не частіше ніж раз на 6 годин.",
  "Secrets": "Секрети",
  "stored in the OS keychain by PyShell": "зберігаються в системному keychain",
  "Every secret PyShell has stored, across all scripts. Values never leave the keychain — this list cannot show them, only remove them. Secrets are deleted along with their script.":
    "Усі секрети, які PyShell зберіг, для всіх скриптів. Значення ніколи не покидають keychain — цей список не може їх показати, лише видалити. Секрети видаляються разом зі своїм скриптом.",
  "No secrets stored.": "Секретів не збережено.",
  "Secret {key} deleted from the keychain": "Секрет {key} видалено з keychain",
  "Delete this secret from the keychain": "Видалити цей секрет із keychain",
  "Set at": "Встановлено",
  "Unknown script": "Невідомий скрипт",
  "About": "Про застосунок",
  "version {version}": "версія {version}",
  "Check for updates": "Перевірити оновлення",
  "Checking…": "Перевірка…",
  "Download": "Завантажити",
  "PyShell is up to date": "PyShell актуальний",
  "PyShell checks GitHub for a newer release and says so when one appears. It does not install updates itself — Download opens the release page, where you get the .dmg.":
    "PyShell перевіряє GitHub на наявність нового релізу і повідомляє, коли той з'являється. Оновлення не встановлюються автоматично — «Завантажити» відкриває сторінку релізу, звідки можна забрати .dmg.",

  // --- Error prefixes (paired with technical messages from Rust) -----------------
  "Import failed": "Помилка імпорту",
  "Run failed": "Помилка запуску",
  "Manifest reload failed": "Не вдалося перечитати маніфест",
  "Env status check failed": "Не вдалося перевірити стан середовища",
  "Failed to load script": "Не вдалося завантажити скрипт",
  "Failed to list dependencies": "Не вдалося отримати список залежностей",
  "Environment setup failed": "Не вдалося налаштувати середовище",
  "Refresh failed": "Помилка оновлення",
  "Relink reload failed": "Не вдалося перечитати скрипт після перелінкування",
  "Duplicate failed": "Не вдалося здублювати",
  "Export failed": "Помилка експорту",
  "Introspection failed": "Помилка інтроспекції",
  "Save manifest failed": "Не вдалося зберегти маніфест",
  "Save preset failed": "Не вдалося зберегти пресет",
  "Delete preset failed": "Не вдалося видалити пресет",
  "Rename preset failed": "Не вдалося перейменувати пресет",
  "Readme load failed": "Не вдалося завантажити документацію",
  "Command preview failed": "Не вдалося показати прев'ю команди",
  "Could not open past run": "Не вдалося відкрити минулий запуск",
  "Could not read script": "Не вдалося прочитати скрипт",
  "Could not load script state": "Не вдалося завантажити стан скрипта",
  "Could not load settings": "Не вдалося завантажити налаштування",
  "Could not save settings": "Не вдалося зберегти налаштування",
  "Could not read disk usage": "Не вдалося прочитати займане місце",
  "Could not list secrets": "Не вдалося отримати список секретів",
  "Could not delete the secret": "Не вдалося видалити секрет",
  "Could not open the release page": "Не вдалося відкрити сторінку релізу",
  "Update check failed": "Не вдалося перевірити оновлення",
  "Reclaim failed": "Не вдалося звільнити місце",
  "Reset env failed": "Не вдалося видалити середовище",

  // --- Form fields ------------------------------------------------------------------
  "No file selected": "Файл не вибрано",
  "No files selected": "Файли не вибрано",
  "No folder selected": "Теку не вибрано",
  "Choose where to save": "Виберіть, куди зберегти",
  "Browse…": "Огляд…",
  "{n} files selected": {
    one: "Вибрано {n} файл",
    few: "Вибрано {n} файли",
    many: "Вибрано {n} файлів",
  },
  "Save as {name}": "Зберегти як {name}",
  "Enter secret value": "Введіть значення секрету",
  "Stored in the system keychain, passed to the script as an env var.": "Зберігається в системному keychain і передається скрипту як змінна середовища.",
  "Stored in the system keychain": "Зберігається в системному keychain",
  "Change": "Змінити",
  "Delete from keychain": "Видалити з keychain",
  "Delete secret from keychain": "Видалити секрет із keychain",
  "Saved": "Збережено",
  "Unknown field type": "Невідомий тип поля",
  "Clear": "Очистити",
  "Clear selection": "Скинути вибір",
  "Clear all": "Очистити всі",
  "Select all": "Вибрати всі",
  "{n} of {m} selected": "Вибрано {n} із {m}",

  // --- Output / Results ---------------------------------------------------------------
  "{n} files": { one: "{n} файл", few: "{n} файли", many: "{n} файлів" },
  "Filter by stream": "Фільтр за потоком",
  "Search log output": "Пошук у логу",
  "No results yet": "Результатів ще немає",
  "This script declares a markdown result. Run it to see the output.":
    "Цей скрипт оголошує markdown-результат. Запустіть його, щоб побачити вивід.",
  "This script declares a table result. Run it to see the output.":
    "Цей скрипт оголошує табличний результат. Запустіть його, щоб побачити вивід.",
  "Tables, charts, markdown and files a script produces show up here. See":
    "Таблиці, графіки, markdown і файли, які створює скрипт, з'являються тут. Дивіться",
  "for examples of how to emit them.": "щоб побачити приклади, як їх генерувати.",
  "Search results": "Пошук у результатах",
  "Search table and files…": "Пошук у таблиці та файлах…",
  "Result": "Результат",
  "Chart": "Графік",
  "Table": "Таблиця",
  "Artifacts": "Артефакти",
  "{n} rows": { one: "{n} рядок", few: "{n} рядки", many: "{n} рядків" },
  "rows": "рядків",
  "No rows match \"{q}\".": "Рядків за запитом «{q}» немає.",
  "Reveal failed": "Не вдалося показати у Finder",
  "Save as failed": "Не вдалося зберегти",
  "Dismiss": "Закрити",

  // --- Docs panel ----------------------------------------------------------------------
  "Default": "Стандартна",
  "documentation": "документація",
  "This file is empty.": "Цей файл порожній.",
  "Reveal in Finder": "Показати у Finder",
  "Close (Esc)": "Закрити (Esc)",
  "Close documentation": "Закрити документацію",
  "Documentation language": "Мова документації",
  "Run panes": "Панелі запуску",
  "new content": "новий вміст",
};

/** Which plural slot a count falls into — Slavic rules (Ukrainian). */
export function pluralForm(n: number): PluralSlot {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "one";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "few";
  return "many";
}

/** Replace `{name}` placeholders with params. Unknown placeholders stay. */
export function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}

function resolve(lang: Lang, key: string): Entry | undefined {
  if (lang === "ua") return ua[key] ?? en[key];
  return en[key];
}

/**
 * Translate `key` (the English source string) into `lang`, interpolating
 * `{placeholders}` from `params`. A plural entry picks its form from
 * `params.n`; a missing translation falls back to English, then to the key
 * itself.
 */
export function translate(
  lang: Lang,
  key: string,
  params?: Record<string, string | number>,
): string {
  const entry = resolve(lang, key);
  let template: string;
  if (entry === undefined) {
    template = key;
  } else if (typeof entry === "string") {
    template = entry;
  } else {
    const slot =
      typeof params?.n === "number" && Number.isFinite(params.n)
        ? pluralForm(params.n)
        : "many";
    template = entry[slot] ?? entry.many;
  }
  return interpolate(template, params);
}

/** Detect the startup language: a stored choice wins, else the system locale. */
export function detectLang(): Lang {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === "en" || raw === "ua") return raw;
  } catch {
    // Storage unavailable — fall through to the system locale.
  }
  const locale = (typeof navigator !== "undefined" ? navigator.language : "en").toLowerCase();
  return locale.startsWith("uk") || locale.startsWith("ua") ? "ua" : "en";
}

export interface I18nApi {
  lang: Lang;
  setLang: (lang: Lang) => void;
  /** Translate the English source string `key`. */
  t: (key: string, params?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nApi | null>(null);

export function useI18n(): I18nApi {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within I18nProvider");
  return ctx;
}

export function I18nProvider({ children }: { children: ComponentChild }) {
  const [lang, setLangState] = useState<Lang>(detectLang);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Not persisting is survivable; the choice still applies for this session.
    }
  }, []);

  // Keep <html lang> in step, so screen readers pick the right voice.
  useEffect(() => {
    document.documentElement.lang = lang === "ua" ? "uk" : "en";
  }, [lang]);

  const t = useCallback(
    (key: string, params?: Record<string, string | number>) => translate(lang, key, params),
    [lang],
  );

  return <I18nContext.Provider value={{ lang, setLang, t }}>{children}</I18nContext.Provider>;
}
