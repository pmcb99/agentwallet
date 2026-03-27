import { getDb, initializeSchema } from "./connection.js";

const db = getDb();
initializeSchema(db);
console.log("Database schema initialized.");
