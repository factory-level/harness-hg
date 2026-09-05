import { describe, expect, test } from "bun:test";
import { repositoryAuthKeys } from "./index.ts";

describe("repositoryAuthKeys", () => {
  test("an https source gets username+password, filled by a token", () => {
    expect(repositoryAuthKeys("https://github.com/o/r.git", "tok")).toEqual({ username: "x-access-token", password: "tok" });
    expect(repositoryAuthKeys("https://github.com/o/r.git")).toEqual({ username: "local-dev", password: "local-dev-placeholder" });
  });
  test("an ssh source gets ssh-privatekey, never a token", () => {
    expect(repositoryAuthKeys("git@github.com:o/r.git", "tok")).toEqual({ "ssh-privatekey": "" });
    expect(repositoryAuthKeys(undefined)).toEqual({ "ssh-privatekey": "" });
  });
});
