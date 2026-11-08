import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import ReactMarkdown from "react-markdown";
import { MarkdownLink } from "@/components/ui/markdown-link";
import {
  markdownRehypePlugins,
  markdownUrlTransform,
} from "./markdownRehypePlugins";

function renderMarkdown(markdown: string, onOpen: (path: string) => void) {
  return render(
    <ReactMarkdown
      rehypePlugins={markdownRehypePlugins}
      urlTransform={markdownUrlTransform}
      components={{
        a: (props) => <MarkdownLink {...props} onOpenLocalPath={onOpen} />,
      }}
    >
      {markdown}
    </ReactMarkdown>,
  );
}

describe("file links through the shared Markdown pipeline", () => {
  it("opens a host-less file URL in the file browser after sanitization", () => {
    const onOpen = vi.fn();
    renderMarkdown("[report](file:///Users/me/repo/report%20v2.md)", onOpen);
    const link = screen.getByRole("link", { name: "report" });
    expect(link).toHaveAttribute(
      "href",
      "file:///Users/me/repo/report%20v2.md",
    );
    fireEvent.click(link);
    expect(onOpen).toHaveBeenCalledWith("/Users/me/repo/report v2.md");
  });

  it("also keeps raw HTML file links that pass sanitization", () => {
    const onOpen = vi.fn();
    renderMarkdown('<a href="file:///tmp/notes.md">notes</a>', onOpen);
    fireEvent.click(screen.getByText("notes"));
    expect(onOpen).toHaveBeenCalledWith("/tmp/notes.md");
  });

  it("still strips remote-host file URLs and executable schemes", () => {
    const onOpen = vi.fn();
    renderMarkdown(
      '[remote](file://server/share.md) [js](javascript:alert(1)) <a href="vbscript:x">vb</a>',
      onOpen,
    );
    for (const name of ["remote", "js", "vb"]) {
      const element = screen.getByText(name);
      expect(element.getAttribute("href") ?? "").not.toMatch(
        /^(file|javascript|vbscript):/i,
      );
      fireEvent.click(element);
    }
    expect(onOpen).not.toHaveBeenCalled();
  });
});
