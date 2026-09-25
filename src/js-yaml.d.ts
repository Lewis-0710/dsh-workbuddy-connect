/**
 * Local type declaration for js-yaml.
 *
 * The Host's own tree ships js-yaml untyped (it is cordis-plugin-include's
 * runtime dependency), and this bundle compiles against the 0.1.5 package graph
 * where no `@types/js-yaml` exists. Only the one call this plugin makes is
 * declared; the CJS default-export shape is spelled out because that is what
 * the bundler inlines.
 */

declare module 'js-yaml' {
  interface JsYamlModule {
    /** Parse a YAML document into a plain value. */
    load?: (text: string) => unknown
    /** The CJS default export, present when the bundler keeps the module shape. */
    default?: { load?: (text: string) => unknown }
  }
  const yaml: JsYamlModule
  export default yaml
}
