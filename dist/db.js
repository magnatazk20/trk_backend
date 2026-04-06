"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DB_NAME = exports.DB_PASSWORD = exports.DB_USER = exports.DB_PORT = exports.DB_HOST = void 0;
const promise_1 = __importDefault(require("mysql2/promise"));
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
exports.DB_HOST = process.env.DB_HOST ?? 'localhost';
exports.DB_PORT = Number(process.env.DB_PORT ?? 3306);
exports.DB_USER = process.env.DB_USER ?? 'root';
exports.DB_PASSWORD = process.env.DB_PASSWORD ?? '';
exports.DB_NAME = process.env.DB_NAME ?? 'noor661';
const pool = promise_1.default.createPool({
    host: exports.DB_HOST,
    port: exports.DB_PORT,
    user: exports.DB_USER,
    password: exports.DB_PASSWORD,
    database: exports.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    charset: 'utf8mb4',
});
exports.default = pool;
