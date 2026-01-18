import { createPromiseClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { LanguageServerService } from "@/gen/src/proto/language_server_connect";

const transport = createConnectTransport({
  httpVersion: "2",
  baseUrl: "http://localhost:3000",
});

export const languageClient = createPromiseClient(LanguageServerService, transport);
