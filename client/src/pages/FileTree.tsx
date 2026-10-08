import { ChevronRight, File, Folder, FolderOpen } from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
	TextFileEditor,
	WRITES_DISABLED_LABEL,
	WRITES_UNKNOWN_LABEL,
} from "../components/TextFileEditor.tsx";
import { useApi } from "../hooks/useApi.ts";
import "./FileTree.css";

interface DirEntry {
	name: string;
	type: "file" | "directory";
	size: number;
}

interface DirListing {
	entries: DirEntry[];
	truncated: boolean;
}

export interface TreeNode {
	name: string;
	path: string;
	type: "file" | "directory";
	size: number;
	children?: TreeNode[];
	expanded: boolean;
	loading: boolean;
}

function findNode(nodes: TreeNode[], dirPath: string): TreeNode | null {
	for (const node of nodes) {
		if (node.path === dirPath) return node;
		if (node.children) {
			const found = findNode(node.children, dirPath);
			if (found) return found;
		}
	}
	return null;
}

// Applies `update` to the node at `dirPath`, wherever it sits in the tree.
function updateNode(
	nodes: TreeNode[],
	dirPath: string,
	update: (node: TreeNode) => TreeNode,
): TreeNode[] {
	return nodes.map((node) => {
		if (node.path === dirPath) return update(node);
		if (node.children) {
			return { ...node, children: updateNode(node.children, dirPath, update) };
		}
		return node;
	});
}

// A folder's entries read again, keeping each folder that is still there as
// it was, open or closed, with whatever had been read of it.
function mergeListing(previous: TreeNode[], fresh: TreeNode[]): TreeNode[] {
	const kept = new Map(previous.map((node) => [node.path, node]));
	return fresh.map((node) => {
		const old = kept.get(node.path);
		return old?.type === node.type ? old : node;
	});
}

/**
 * The repo's folder tree, read a folder at a time as each is opened.
 */
export function useFileTree(repoName: string) {
	const { request } = useApi();
	const [nodes, setNodes] = useState<TreeNode[]>([]);
	const nodesRef = useRef<TreeNode[]>([]);
	nodesRef.current = nodes;
	const [rootLoading, setRootLoading] = useState(true);
	const [truncated, setTruncated] = useState(false);

	// Null when the listing could not be read.
	const fetchDirectory = useCallback(
		async (
			dirPath: string,
			silent = false,
		): Promise<{ nodes: TreeNode[]; truncated: boolean } | null> => {
			const data = await request<DirListing>(
				`/api/files?repo=${encodeURIComponent(repoName)}&path=${encodeURIComponent(dirPath)}`,
				{ silent },
			);
			if (!data) return null;
			return {
				nodes: data.entries.map((entry) => ({
					name: entry.name,
					path: dirPath === "." ? entry.name : `${dirPath}/${entry.name}`,
					type: entry.type,
					size: entry.size,
					expanded: false,
					loading: false,
				})),
				truncated: data.truncated,
			};
		},
		[request, repoName],
	);

	// Load root directory on mount
	useEffect(() => {
		let current = true;
		(async () => {
			const listing = await fetchDirectory(".");
			if (!current) return;
			setNodes(listing?.nodes ?? []);
			setTruncated(listing?.truncated ?? false);
			setRootLoading(false);
		})();
		return () => {
			current = false;
		};
	}, [fetchDirectory]);

	const toggleDirectory = useCallback(
		async (dirPath: string) => {
			// Read current state from ref to avoid stale closures
			const target = findNode(nodesRef.current, dirPath);
			if (target?.type !== "directory") return;

			setNodes((prev) =>
				updateNode(prev, dirPath, (node) => {
					if (node.expanded) {
						return { ...node, expanded: false };
					}
					if (node.children) {
						return { ...node, expanded: true };
					}
					return { ...node, expanded: true, loading: true };
				}),
			);

			if (!target.expanded && !target.children) {
				const children = (await fetchDirectory(dirPath))?.nodes ?? [];
				setNodes((prev) =>
					updateNode(prev, dirPath, (node) => ({
						...node,
						children,
						loading: false,
					})),
				);
			}
		},
		[fetchDirectory],
	);

	const ensureExpanded = useCallback(
		(dirPath: string) => {
			const target = findNode(nodesRef.current, dirPath);
			if (target?.type !== "directory" || target.expanded) return;
			toggleDirectory(dirPath);
		},
		[toggleDirectory],
	);

	// The folder holding `path` whose entries have been read, or the root, which
	// always has been.
	const loadedFolderOf = useCallback((path: string): string => {
		let dir = path.replace(/\/$/, "");
		do {
			const slash = dir.lastIndexOf("/");
			dir = slash === -1 ? "." : dir.slice(0, slash);
		} while (dir !== "." && !findNode(nodesRef.current, dir)?.children);
		return dir;
	}, []);

	// Reads folders again in the background. One that cannot be read keeps
	// the entries it has.
	const refreshDirectories = useCallback(
		async (dirPaths: string[]) => {
			await Promise.all(
				dirPaths.map(async (dirPath) => {
					const listing = await fetchDirectory(dirPath, true);
					if (!listing) return;
					if (dirPath === ".") {
						setNodes((prev) => mergeListing(prev, listing.nodes));
						setTruncated(listing.truncated);
						return;
					}
					setNodes((prev) =>
						updateNode(prev, dirPath, (node) =>
							node.children
								? {
										...node,
										children: mergeListing(node.children, listing.nodes),
									}
								: node,
						),
					);
				}),
			);
		},
		[fetchDirectory],
	);

	// Reads again the root and every folder whose entries have been read,
	// open or closed.
	const refreshLoaded = useCallback(() => {
		const loaded = ["."];
		const collect = (list: TreeNode[]) => {
			for (const node of list) {
				if (!node.children) continue;
				loaded.push(node.path);
				collect(node.children);
			}
		};
		collect(nodesRef.current);
		return refreshDirectories(loaded);
	}, [refreshDirectories]);

	return {
		nodes,
		rootLoading,
		truncated,
		toggleDirectory,
		ensureExpanded,
		loadedFolderOf,
		refreshDirectories,
		refreshLoaded,
	};
}

// Memoised, since the tree can hold a thousand entries and the page renders
// it again whenever its own state changes, even while a file is open over it.
export const TreeEntry = memo(function TreeEntry({
	node,
	onToggle,
	onFileSelect,
	isHidden,
	depth,
}: {
	node: TreeNode;
	onToggle: (path: string) => void;
	onFileSelect: (path: string) => void;
	// Files to leave out, such as those listed with the changes. Folders stay,
	// however much of them is left out.
	isHidden?: (path: string) => boolean;
	depth: number;
}) {
	if (node.type === "file" && isHidden?.(node.path)) return null;

	const handleClick = () => {
		if (node.type === "directory") {
			onToggle(node.path);
		} else {
			onFileSelect(node.path);
		}
	};

	return (
		<>
			<button
				type="button"
				className="tree-entry"
				onClick={handleClick}
				style={{ paddingLeft: `${depth * 1.25 + 1}rem` }}
			>
				{node.type === "directory" ? (
					<span className="tree-entry-icon tree-entry-icon--folder">
						{node.expanded ? <FolderOpen size={18} /> : <Folder size={18} />}
					</span>
				) : (
					<span className="tree-entry-icon">
						<File size={18} />
					</span>
				)}
				<span className="tree-entry-name">{node.name}</span>
				{node.type === "directory" && (
					<ChevronRight
						size={18}
						className={`tree-chevron ${node.expanded ? "tree-chevron-open" : ""}`}
					/>
				)}
			</button>
			{node.expanded && node.loading && (
				<div
					className="tree-loading"
					style={{ paddingLeft: `${(depth + 1) * 1.25 + 1}rem` }}
				>
					Loading...
				</div>
			)}
			{node.expanded &&
				node.children?.map((child) => (
					<TreeEntry
						key={child.path}
						node={child}
						onToggle={onToggle}
						onFileSelect={onFileSelect}
						isHidden={isHidden}
						depth={depth + 1}
					/>
				))}
		</>
	);
});

/**
 * A file opened from the tree of a directory without git: the editor alone,
 * whose Back opens the file's folder in the tree.
 */
export function FileViewer({
	filePath,
	onNavigate,
	repo,
	writesAllowed,
}: {
	filePath: string;
	onNavigate: (dir: string) => void;
	repo: string;
	writesAllowed: boolean | null;
}) {
	return (
		<div className="file-viewer">
			<TextFileEditor
				filePath={filePath}
				repo={repo}
				readOnly={writesAllowed !== true}
				readOnlyLabel={
					writesAllowed === false ? WRITES_DISABLED_LABEL : WRITES_UNKNOWN_LABEL
				}
				onBack={() => {
					const slash = filePath.lastIndexOf("/");
					onNavigate(slash === -1 ? "." : filePath.slice(0, slash));
				}}
				backLabel="Back to file tree"
			/>
		</div>
	);
}
