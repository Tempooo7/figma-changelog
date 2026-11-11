// Small fake Figma trees used by the tests.

const box = (x, y, width, height) => ({ x, y, width, height });
const solid = (r, g, b, extra = {}) => ({ type: 'SOLID', color: { r, g, b, a: 1 }, ...extra });

export function snapshotV1() {
  return {
    pages: [
      {
        id: '0:1',
        name: 'Mobile',
        type: 'CANVAS',
        children: [
          {
            id: '1:1', name: 'Home', type: 'FRAME', absoluteBoundingBox: box(0, 0, 375, 812), fills: [solid(1, 1, 1)],
            children: [
              { id: '1:2', name: 'Title', type: 'TEXT', characters: 'مرحبا', absoluteBoundingBox: box(16, 40, 100, 24.0) },
              { id: '1:3', name: 'CTA', type: 'RECTANGLE', absoluteBoundingBox: box(16, 700, 343, 48), fills: [solid(0.102, 0.451, 0.91)], cornerRadius: 8 },
              {
                id: '1:4', name: 'Card', type: 'FRAME', layoutMode: 'VERTICAL', primaryAxisSizingMode: 'AUTO', counterAxisSizingMode: 'FIXED',
                itemSpacing: 8, paddingTop: 12, paddingRight: 12, paddingBottom: 12, paddingLeft: 12,
                absoluteBoundingBox: box(16, 100, 343, 200),
                children: [{ id: '1:6', name: 'Badge old', type: 'RECTANGLE', absoluteBoundingBox: box(20, 110, 10, 10) }],
              },
              {
                id: '1:5', name: 'Button', type: 'INSTANCE', componentId: '9:1', absoluteBoundingBox: box(16, 600, 120, 40),
                componentProperties: { State: { type: 'VARIANT', value: 'Default' }, 'Label#1:0': { type: 'TEXT', value: 'Go' } },
                children: [{ id: 'I1:5;9:9', name: 'Label', type: 'TEXT', characters: 'Go', absoluteBoundingBox: box(20, 610, 20, 16) }],
              },
              { id: '1:7', name: 'Hint', type: 'TEXT', characters: 'hint', absoluteBoundingBox: box(16, 760, 50, 16) },
            ],
          },
          {
            id: '5:0', name: 'Flows', type: 'SECTION',
            children: [{ id: '2:1', name: 'Settings', type: 'FRAME', absoluteBoundingBox: box(500, 0, 375, 812), children: [] }],
          },
          { id: '4:1', name: 'Old screen', type: 'FRAME', absoluteBoundingBox: box(1000, 0, 375, 812), children: [] },
        ],
      },
    ],
    components: {
      '9:1': { name: 'State=Default', componentSetId: '9:0' },
      '9:2': { name: 'State=Hover', componentSetId: '9:0' },
    },
    componentSets: { '9:0': { name: 'Button' } },
    styles: {},
  };
}

/** V2: a realistic mix of edits on top of V1. */
export function snapshotV2() {
  const s = snapshotV1();
  const home = s.pages[0].children[0];
  const [title, cta, card, button, hint] = home.children;
  title.characters = 'أهلاً وسهلاً';
  title.absoluteBoundingBox = box(16.2, 40, 140, 24.0001); // text resize: ignored
  cta.fills = [solid(0.043, 0.341, 0.816, { boundVariables: { color: { type: 'VARIABLE_ALIAS', id: 'VariableID:1:23' } } })];
  card.paddingLeft = 16;
  card.paddingRight = 16;
  card.absoluteBoundingBox = box(16, 100, 343, 260); // height hugs content: ignored
  card.children = [{ id: '1:9', name: 'New badge', type: 'RECTANGLE', absoluteBoundingBox: box(20, 110, 10, 10) }];
  button.componentId = '9:2';
  button.componentProperties = { State: { type: 'VARIANT', value: 'Hover' }, 'Label#1:0': { type: 'TEXT', value: 'Go' } };
  hint.visible = false;
  home.absoluteBoundingBox = box(0.3, 0, 375, 812); // float jitter: ignored
  // Old screen deleted, Approvals added
  s.pages[0].children = s.pages[0].children.filter((n) => n.id !== '4:1');
  s.pages[0].children.push({ id: '3:1', name: 'Approvals', type: 'FRAME', absoluteBoundingBox: box(1500, 0, 375, 812), children: [] });
  // Settings renamed
  s.pages[0].children[1].children[0].name = 'Settings v2';
  return s;
}
