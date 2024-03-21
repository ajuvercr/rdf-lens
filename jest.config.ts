import type { Config } from "@jest/types";
import dotenv from "dotenv";

dotenv.config();

const config: Config.InitialOptions = {
    preset: "ts-jest",
    testEnvironment: "node",
    roots: ["<rootDir>"],
    moduleFileExtensions: ["ts", "tsx", "js", "jsx", "json", "node"],
    testMatch: ["<rootDir>/tests/**/*.test.ts"],
    transform: {
        "^.+\\.tsx?$": "ts-jest",
    },
};

export default config;
