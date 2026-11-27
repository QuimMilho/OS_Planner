// The boards entry point (`@os-planner/shared/boards`): board, column, task and label schemas, the reduced task description
// document, due-date grouping and label colours. Kept apart from the main entry so the website's first load does not carry
// them: only the board screens (a lazy chunk) and the server import it. The TYPES are also exported from the main entry.
export * from './dto/boards';
export * from './boards/description';
export * from './boards/due';
export * from './boards/color';
