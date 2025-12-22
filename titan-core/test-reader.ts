import { readFileSafe } from "./reader";

const result = readFileSafe(
  process.cwd(),
  "src/chatProvider.ts"
);

if (!result) {
  console.log("File could not be read");
} else {
  console.log("Path:", result.path);
  console.log("Truncated:", result.truncated);
  console.log("Content preview:");
  console.log(result.content.slice(0, 200));
}
