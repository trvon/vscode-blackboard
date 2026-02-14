import test from "node:test";
import assert from "node:assert/strict";

import { YamsBlackboard } from "../src/blackboard/blackboard.js";
import type { YamsDaemonClient } from "../src/daemon/client.js";

type AddCall = {
    content: string;
    name: string;
    tags: string[];
    metadata: Array<{ key: string; value: string }>;
};

type FakeListEntry = { name: string };

class FakeClient {
    public addCalls: AddCall[] = [];
    public useSessionCalls: string[] = [];
    public lastListOpts: any | undefined;

    public updateCalls: any[] = [];

    private docs = new Map<string, { content: string; tags: string[]; metadata: Array<{ key: string; value: string }> }>();

    async add(opts: {
        content: string;
        name: string;
        tags?: string[];
        metadata?: Array<{ key: string; value: string }>;
    }): Promise<any> {
        const tags = opts.tags ?? [];
        const metadata = opts.metadata ?? [];
        this.addCalls.push({
            content: opts.content,
            name: opts.name,
            tags,
            metadata,
        });
        this.docs.set(opts.name, { content: opts.content, tags, metadata });
        return { ok: true };
    }

    async cat(opts: { name?: string; hash?: string }): Promise<any> {
        const name = opts.name ?? "";

        const exact = this.docs.get(name);
        if (exact) {
            return { content: new TextEncoder().encode(exact.content) };
        }

        // Minimal glob support for patterns like findings/**/id.md
        if (name.includes("*") || name.includes("?")) {
            const re = globToRegExp(name);
            for (const [k, v] of this.docs.entries()) {
                if (re.test(k)) {
                    return { content: new TextEncoder().encode(v.content) };
                }
            }
        }

        throw new Error(`not found: ${name}`);
    }

    async list(opts: {
        tags?: string[];
        matchAllTags?: boolean;
        limit?: number;
        offset?: number;
        namePattern?: string;
    }): Promise<any> {
        this.lastListOpts = opts;
        const want = (opts.tags ?? []).filter(Boolean);
        const matchAll = opts.matchAllTags ?? false;
        const namePattern = opts.namePattern;

        const itemsAll: FakeListEntry[] = [];
        for (const [name, doc] of this.docs.entries()) {
            if (namePattern) {
                const re = globToRegExp(namePattern);
                if (!re.test(name)) continue;
            }

            if (want.length > 0) {
                const hasAll = want.every((t) => doc.tags.includes(t));
                const hasAny = want.some((t) => doc.tags.includes(t));
                if (matchAll ? !hasAll : !hasAny) continue;
            }

            itemsAll.push({ name });
        }

        const offset = opts.offset ?? 0;
        const limit = opts.limit ?? itemsAll.length;
        const items = itemsAll.slice(offset, offset + limit);
        return { items };
    }

    async useSession(name: string): Promise<any> {
        this.useSessionCalls.push(name);
        return { ok: true };
    }

    // These exist on the real client but aren't needed in this suite.
    async update(): Promise<any> {
        // NOTE: We keep this permissive but we do emulate addTags/metadata for matching docs.
        const args = arguments[0] as any;
        this.updateCalls.push(args);

        const pattern = args?.name;
        const addTags: string[] = args?.addTags ?? [];
        const metadata: Array<{ key: string; value: string }> = args?.metadata ?? [];
        if (typeof pattern === "string") {
            const re = globToRegExp(pattern);
            for (const [name, doc] of this.docs.entries()) {
                if (!re.test(name)) continue;
                const newTags = [...new Set([...doc.tags, ...addTags])];
                const newMeta = [...doc.metadata, ...metadata];
                this.docs.set(name, { ...doc, tags: newTags, metadata: newMeta });
            }
        }

        return { ok: true };
    }

    async search(opts: {
        query: string;
        tags?: string[];
        matchAllTags?: boolean;
        limit?: number;
    }): Promise<any> {
        const query = (opts.query ?? "").toLowerCase();
        const tags = opts.tags ?? [];
        const matchAll = opts.matchAllTags ?? false;
        const limit = opts.limit ?? 20;

        const results: Array<{ path: string }> = [];
        for (const [name, doc] of this.docs.entries()) {
            if (tags.length > 0) {
                const hasAll = tags.every((t) => doc.tags.includes(t));
                const hasAny = tags.some((t) => doc.tags.includes(t));
                if (matchAll ? !hasAll : !hasAny) continue;
            }

            const hay = `${name}\n${doc.content}`.toLowerCase();
            if (!hay.includes(query)) continue;

            results.push({ path: name });
            if (results.length >= limit) break;
        }

        return { results };
    }

    async grep(opts: {
        pattern: string;
        filterTags?: string[];
        matchAllTags?: boolean;
    }): Promise<any> {
        const pattern = opts.pattern ?? "";
        const filterTags = opts.filterTags ?? [];
        const matchAll = opts.matchAllTags ?? false;
        const re = new RegExp(pattern, "i");

        const matches: Array<{ file: string; line: Uint8Array }> = [];
        for (const [name, doc] of this.docs.entries()) {
            if (filterTags.length > 0) {
                const hasAll = filterTags.every((t) => doc.tags.includes(t));
                const hasAny = filterTags.some((t) => doc.tags.includes(t));
                if (matchAll ? !hasAll : !hasAny) continue;
            }

            for (const line of doc.content.split("\n")) {
                if (!re.test(line)) continue;
                matches.push({ file: name, line: new TextEncoder().encode(line) });
            }
        }

        return { matches };
    }

    seedDoc(name: string, content: string): void {
        this.docs.set(name, { content, tags: [], metadata: [] });
    }

    seedTaggedDoc(name: string, content: string, tags: string[]): void {
        this.docs.set(name, { content, tags, metadata: [] });
    }
}

function globToRegExp(glob: string): RegExp {
    // Good enough for our internal patterns: ** and * wildcards.
    const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    const withDoubleStar = escaped.replace(/\*\*/g, ".*");
    const withSingleStar = withDoubleStar.replace(/\*/g, "[^/]*");
    const withQ = withSingleStar.replace(/\?/g, ".");
    return new RegExp(`^${withQ}$`);
}

function createBb(fake: FakeClient, instanceId = "test-inst"): YamsBlackboard {
    return new YamsBlackboard(fake as unknown as YamsDaemonClient, {
        instanceId,
    });
}

test("startSession defaults to vscode-* and calls useSession", async () => {
    const fake = new FakeClient();
    const bb = createBb(fake);

    const name = await bb.startSession();

    assert.ok(name.startsWith("vscode-"));
    assert.equal(fake.useSessionCalls.length, 1);
    assert.equal(fake.useSessionCalls[0], name);
});

test("registerAgent stores agent doc with owner=vscode metadata", async () => {
    const fake = new FakeClient();
    const bb = createBb(fake, "inst-123");

    await bb.registerAgent({
        id: "vscode-yams-abc",
        name: "VS Code Agent",
        capabilities: ["yams", "coordination"],
        status: "active",
    });

    assert.equal(fake.addCalls.length, 1);
    const call = fake.addCalls[0];
    assert.equal(call.name, "agents/vscode-yams-abc.json");
    assert.ok(call.tags.includes("agent"));
    assert.ok(call.tags.includes("inst:inst-123"));

    const ownerMeta = call.metadata.find((m) => m.key === "owner");
    assert.deepEqual(ownerMeta, { key: "owner", value: "vscode" });
});

test("registerAgent is idempotent even if capabilities reorder", async () => {
    const fake = new FakeClient();
    const bb = createBb(fake);

    await bb.registerAgent({
        id: "vscode-yams-1",
        name: "Agent One",
        capabilities: ["yams", "search"],
        status: "active",
    });

    await bb.registerAgent({
        id: "vscode-yams-1",
        name: "Agent One",
        capabilities: ["search", "yams"],
        status: "active",
    });

    assert.equal(fake.addCalls.length, 1);
});

test("listAgents returns parsable agent docs and skips malformed with optional instance filter", async () => {
    const fake = new FakeClient();
    const bb = createBb(fake, "inst-xyz");

    fake.seedTaggedDoc(
        "agents/good.json",
        JSON.stringify(
            {
                id: "good",
                name: "Good",
                capabilities: ["a"],
                registered_at: "2026-01-01T00:00:00.000Z",
                status: "active",
            },
            null,
            2,
        ),
        ["agent", "inst:inst-xyz"],
    );
    fake.seedTaggedDoc("agents/bad.json", "not-json", ["agent", "inst:inst-xyz"]);

    const agents = await bb.listAgents("inst-xyz");

    assert.equal(Array.isArray(agents), true);
    assert.equal(agents.length, 1);
    assert.equal(agents[0]?.id, "good");
    assert.ok(fake.lastListOpts?.tags?.includes("agent"));
    assert.ok(fake.lastListOpts?.tags?.includes("inst:inst-xyz"));
});

test("postFinding stores markdown with frontmatter and getFinding parses it", async () => {
    const fake = new FakeClient();
    const bb = createBb(fake, "inst-find");

    const realNow = Date.now;
    const realRand = Math.random;
    Date.now = () => 1234;
    Math.random = () => 0.123456;

    try {
        const created = await bb.postFinding({
            agent_id: "vscode-yams-abc",
            topic: "bug",
            title: "It breaks",
            content: "Repro steps...",
            confidence: 0.9,
            scope: "session",
        });

        if (!created.id) {
            assert.fail("expected created finding to have an id");
        }

        const id: string = created.id;

        assert.ok(id.startsWith("f-1234-"));
        assert.equal(fake.addCalls.length, 1);
        assert.ok(fake.addCalls[0].name.endsWith(`/${id}.md`));
        assert.ok(fake.addCalls[0].tags.includes("finding"));
        assert.ok(fake.addCalls[0].tags.includes("topic:bug"));
        assert.ok(fake.addCalls[0].tags.includes("agent:vscode-yams-abc"));

        const fetched = await bb.getFinding(id);
        assert.ok(fetched);
        assert.equal(fetched!.id, id);
        assert.equal(fetched!.title, "It breaks");
        assert.equal(fetched!.content, "Repro steps...");
        assert.equal(fetched!.topic, "bug");
        assert.equal(fetched!.agent_id, "vscode-yams-abc");
    } finally {
        Date.now = realNow;
        Math.random = realRand;
    }
});

test("queryFindings filters by min_confidence", async () => {
    const fake = new FakeClient();
    const bb = createBb(fake, "inst-qf");

    // Seed two findings docs with tags so listDocs can find them.
    const makeFindingMd = (id: string, confidence: number) => `---\n` +
        `id: ${JSON.stringify(id)}\n` +
        `agent_id: ${JSON.stringify("a1")}\n` +
        `topic: ${JSON.stringify("bug")}\n` +
        `confidence: ${JSON.stringify(confidence)}\n` +
        `status: ${JSON.stringify("published")}\n` +
        `scope: ${JSON.stringify("persistent")}\n` +
        `created_at: ${JSON.stringify("2026-01-01T00:00:00.000Z")}\n` +
        `---\n\n# T\n\nC\n`;

    fake.seedTaggedDoc(
        "findings/bug/f-hi.md",
        makeFindingMd("f-hi", 0.9),
        ["finding", "inst:inst-qf", "topic:bug", "agent:a1", "scope:persistent", "status:published"],
    );
    fake.seedTaggedDoc(
        "findings/bug/f-lo.md",
        makeFindingMd("f-lo", 0.2),
        ["finding", "inst:inst-qf", "topic:bug", "agent:a1", "scope:persistent", "status:published"],
    );

    const results = await bb.queryFindings({
        topic: "bug",
        min_confidence: 0.5,
        limit: 50,
        offset: 0,
    } as any);

    assert.equal(results.length, 1);
    assert.equal(results[0]!.id, "f-hi");
});

test("search returns mixed finding/task results with optional instance filter", async () => {
    const fake = new FakeClient();
    const bb = createBb(fake, "inst-srch");

    const findingMd = `---\n` +
        `id: ${JSON.stringify("f-1")}\n` +
        `agent_id: ${JSON.stringify("a1")}\n` +
        `topic: ${JSON.stringify("security")}\n` +
        `confidence: 0.9\n` +
        `status: ${JSON.stringify("published")}\n` +
        `scope: ${JSON.stringify("persistent")}\n` +
        `created_at: ${JSON.stringify("2026-01-01T00:00:00.000Z")}\n` +
        `---\n\n# SQL Injection\n\nquery is unsafe\n`;

    fake.seedTaggedDoc(
        "findings/security/f-1.md",
        findingMd,
        ["finding", "inst:inst-srch", "topic:security"],
    );
    fake.seedTaggedDoc(
        "tasks/t-1.json",
        JSON.stringify({
            id: "t-1",
            title: "Fix SQL query",
            type: "fix",
            status: "pending",
            priority: 1,
            created_by: "a1",
        }),
        ["task", "inst:inst-srch", "type:fix", "status:pending"],
    );
    fake.seedTaggedDoc(
        "tasks/t-other.json",
        JSON.stringify({
            id: "t-other",
            title: "Different instance",
            type: "fix",
            status: "pending",
            priority: 2,
            created_by: "a1",
        }),
        ["task", "inst:other", "type:fix", "status:pending"],
    );

    const all = await bb.search("sql", { limit: 20 });
    assert.equal(all.findings.length, 1);
    assert.equal(all.tasks.length, 1);

    const scoped = await bb.search("sql", {
        instance_id: "inst-srch",
        limit: 20,
    });
    assert.equal(scoped.findings.length, 1);
    assert.equal(scoped.tasks.length, 1);
    assert.equal(scoped.tasks[0]?.id, "t-1");
});

test("grep supports entity + instance filtering and groups by file", async () => {
    const fake = new FakeClient();
    const bb = createBb(fake, "inst-grp");

    fake.seedTaggedDoc(
        "findings/bug/f-1.md",
        "first line\nneedle appears here\nlast line",
        ["finding", "inst:inst-grp"],
    );
    fake.seedTaggedDoc(
        "tasks/t-1.json",
        "{\"title\":\"needle task\"}",
        ["task", "inst:inst-grp"],
    );
    fake.seedTaggedDoc(
        "findings/bug/f-other.md",
        "needle but other instance",
        ["finding", "inst:other"],
    );

    const findingOnly = await bb.grep("needle", {
        entity: "finding",
        instance_id: "inst-grp",
        limit: 50,
    });

    assert.equal(findingOnly.length, 1);
    assert.equal(findingOnly[0]?.name, "findings/bug/f-1.md");
    assert.ok((findingOnly[0]?.matches ?? []).some((m) => m.includes("needle")));
});
