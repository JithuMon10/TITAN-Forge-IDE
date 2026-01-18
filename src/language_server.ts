import { connectNodeAdapter } from "@connectrpc/connect-node";
import { LanguageServerService } from "@/gen/src/proto/language_server_connect";
import { 
  GetCompletionsResponse,
  GetCompletionsRequest,
  AcceptCompletionRequest,
  HeartbeatRequest,
  GetAuthTokenRequest,
  RegisterUserRequest,
  CancelRequestMessage
} from "@/gen/src/proto/language_server_pb";
import http2 from "http2";
import { ConnectRouter } from "@connectrpc/connect";

const routes = (router: ConnectRouter) => {
  // Implement the gRPC service
  router.service(LanguageServerService, {
    async getCompletions(req: GetCompletionsRequest) {
      console.log("Request to getCompletions received:", req);
      return new GetCompletionsResponse({
        completionItems: [],
        state: "done",
        requestInfo: "dummy response"
      });
    },
    async acceptCompletion(req: AcceptCompletionRequest) {
      console.log("Request to acceptCompletion received:", req);
      return {};
    },
    async heartbeat(req: HeartbeatRequest) {
      console.log("Request to heartbeat received:", req);
      return {};
    },
    async getAuthToken(req: GetAuthTokenRequest) {
      console.log("Request to getAuthToken received:", req);
      return { authToken: "dummy-auth-token" };
    },
    async registerUser(req: RegisterUserRequest) {
      console.log("Request to registerUser received:", req);
      return { apiKey: "dummy-api-key" };
    },
    async cancelRequest(req: CancelRequestMessage) {
      console.log("Request to cancelRequest received:", req);
      return {};
    },
  });
};

// Create and start the server
http2.createServer(connectNodeAdapter({ routes })).listen(3000, () => {
  console.log("Language server listening on port 3000");
});
