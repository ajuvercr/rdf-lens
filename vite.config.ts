import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
    plugins: [tsconfigPaths()],
    test: {
        deps: {
            optimizer: {
                ssr: {
                    enabled: true,
                    include: ["@ajuvercr/js-runner"],
                },
            },
        },
    },
});
