import { createApiClient } from "./api/client";
import { mountApp } from "./app/app";
import { migrateLegacyStorage } from "./api/storage";
import { registerLibrary } from "./widgets/library";

const root = document.getElementById("app");
if (!root) throw new Error("Missing #app root");

migrateLegacyStorage();
registerLibrary();
mountApp({ api: createApiClient(), root });
