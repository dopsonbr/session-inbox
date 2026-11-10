// Progressive enhancement only: the site reads fine without this file.
// Mobile menu toggle and copy-to-clipboard buttons. No network, no storage.
document.documentElement.classList.add("js")

const toggle = document.querySelector(".menu-toggle")
const nav = document.getElementById("site-nav")

const setMenu = (open) => {
  if (!toggle || !nav) return
  toggle.setAttribute("aria-expanded", String(open))
  nav.classList.toggle("open", open)
}

if (toggle && nav) {
  toggle.addEventListener("click", () => {
    setMenu(toggle.getAttribute("aria-expanded") !== "true")
  })
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && toggle.getAttribute("aria-expanded") === "true") {
      setMenu(false)
      toggle.focus()
    }
  })
}

const copyText = async (text) => {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text)
    return
  }
  // file:// and plain http pages have no async clipboard; fall back to a hidden textarea.
  const area = document.createElement("textarea")
  area.value = text
  area.setAttribute("readonly", "")
  area.style.position = "fixed"
  area.style.opacity = "0"
  document.body.appendChild(area)
  area.select()
  try {
    if (!document.execCommand("copy")) throw new Error("copy failed")
  } finally {
    document.body.removeChild(area)
  }
}

for (const button of document.querySelectorAll(".copyable .copy")) {
  button.addEventListener("click", async () => {
    const code = button.closest(".copyable")?.querySelector("code")
    if (!code) return
    const label = button.textContent
    try {
      await copyText(code.textContent.replace(/\s+$/, ""))
      button.textContent = "Copied"
    } catch {
      button.textContent = "Press Cmd+C"
    }
    setTimeout(() => {
      button.textContent = label
    }, 1600)
  })
}

// Let keyboard users scroll code blocks that overflow.
for (const pre of document.querySelectorAll(".code pre")) {
  if (pre.scrollWidth > pre.clientWidth) pre.setAttribute("tabindex", "0")
}
