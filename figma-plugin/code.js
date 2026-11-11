// Collects variable ID → name for this file (local variables + variables from enabled libraries),
// so the changelog can say "brand/600" instead of "#1A73E8". Figma's REST API only gives variable
// names on Enterprise plans; this plugin works on any plan.
//
// Output goes into variables-map.json in the figma-changelog repo.

async function collect() {
  const map = {};
  let local = 0;
  let library = 0;

  const vars = await figma.variables.getLocalVariablesAsync();
  for (const v of vars) {
    map[v.id] = v.name;
    local++;
  }

  try {
    const collections = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
    for (const c of collections) {
      const libVars = await figma.teamLibrary.getVariablesInLibraryCollectionAsync(c.key);
      for (const v of libVars) {
        // Library variables appear in the REST API as "VariableID:<key>/<id>", so we store them by key.
        map['key:' + v.key] = v.name;
        library++;
      }
    }
  } catch (e) {
    // No libraries enabled, or no access: local variables are still useful.
  }

  return { map, local, library };
}

figma.showUI(__html__, { width: 520, height: 460, title: 'Changelog token names' });
const result = collect();

figma.ui.onmessage = async (msg) => {
  if (msg === 'ready') {
    const { map, local, library } = await result;
    figma.ui.postMessage({ json: JSON.stringify(map, null, 2), local, library });
  }
  if (msg === 'close') figma.closePlugin();
  if (msg === 'copied') figma.notify('Copied. Paste it into variables-map.json');
};
