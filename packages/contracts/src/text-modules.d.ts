// Files Bun imports as text (`with { type: "text" }`).
declare module "*/VERSION" {
  const text: string
  export default text
}
declare module "*.template" {
  const text: string
  export default text
}
