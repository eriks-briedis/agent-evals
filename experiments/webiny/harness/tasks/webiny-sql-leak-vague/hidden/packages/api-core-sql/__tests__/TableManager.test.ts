import { describe } from "vitest";
import { it } from "vitest";
import { expect } from "vitest";
import { afterEach } from "vitest";
import knexLib from "knex";
import type { Knex } from "knex";
import { Container } from "@webiny/feature/api";
import { ApiCoreStorageOperationsFactory } from "@webiny/api-core";
import { ApiCoreSqlFeature } from "~/ApiCoreSqlFeature.js";

const createKnex = (): Knex => {
    return knexLib({
        client: "better-sqlite3",
        connection: {
            filename: ":memory:"
        },
        useNullAsDefault: true
    });
};

const TEST_ENV_KEYS = [
    "NODE_ENV",
    "VITEST",
    "VITEST_WORKER_ID",
    "VITEST_POOL_ID",
    "JEST_WORKER_ID",
    "TEST",
    "CI"
];

// eval-vague: counts the managers the global registry holds strongly, whatever its shape.
// Weak references do not keep a manager alive, so they are not counted.
const countStrong = (value: unknown, depth: number): number => {
    if (value === null || typeof value !== "object" || value instanceof WeakRef) {
        return 0;
    }
    if (value instanceof FinalizationRegistry || value instanceof WeakMap || value instanceof WeakSet) {
        return 0;
    }
    const items: unknown[] | null = Array.isArray(value)
        ? value
        : value instanceof Set
          ? [...value]
          : value instanceof Map
            ? [...value.values()]
            : null;
    if (items) {
        return items.filter(item => item !== null && typeof item === "object" && !(item instanceof WeakRef)).length;
    }
    if (depth <= 0) {
        return 0;
    }
    return Object.values(value).reduce<number>((sum, item) => sum + countStrong(item, depth - 1), 0);
};

const getRegisteredManagers = () => {
    const g = globalThis as Record<string, unknown>;
    return countStrong(g.__sqlTableManagers, 2);
};

// eval-vague: the two TableManager concurrency tests are left out; the ticket is only about memory growth.
describe("ApiCoreSqlFeature", () => {
    let knex: Knex | undefined;

    afterEach(async () => {
        await knex?.destroy();
        knex = undefined;
    });

    it("builds the storage operations once, however many requests create them", () => {
        knex = createKnex();
        const container = new Container();
        // eval-vague: the leak is a production problem, so measure it with the test-runner
        // markers hidden. A fix that keeps the global registry for tests only is valid.
        const saved: Record<string, string | undefined> = {};
        for (const key of TEST_ENV_KEYS) {
            saved[key] = process.env[key];
            delete process.env[key];
        }
        process.env.NODE_ENV = "production";
        const before = getRegisteredManagers();

        ApiCoreSqlFeature.register(container, { knex });
        const factory = container.resolve(ApiCoreStorageOperationsFactory);

        // ApiCoreFeature calls create() once per request.
        const first = factory.create();
        const second = factory.create();
        const third = factory.create();

        const after = getRegisteredManagers();
        for (const key of TEST_ENV_KEYS) {
            if (saved[key] === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = saved[key];
            }
        }

        // eval-vague: returning the same object is one way to fix it, not a requirement.
        void first;
        void second;
        void third;
        expect(after - before).toBeLessThanOrEqual(1); // eval: no extra managers per request; not registering globally at all is fine
    });
});
