/**
 * Closed modifier vocabulary for scene plan version 3. The planner selects option IDs; the
 * plan renderer writes the tags, applies rules and drops tags for body parts that are hidden.
 * Tags are public Danbooru vocabulary written for BardPainter; weights start at 1.
 */
export type PainterView = 'front' | 'side' | 'back'
export type PainterBodyPart = 'head' | 'eyes' | 'top' | 'bottom' | 'legs' | 'feet'
export type PainterViewpoint = 'first-person' | 'third-person'
export const PAINTER_BODY_PARTS: readonly PainterBodyPart[] = Object.freeze(['head', 'eyes', 'top', 'bottom', 'legs', 'feet'])

export interface ModifierCondition {
    /** Any listed option is selected; subject groups read the subject, scene groups the scene. */
    option?: Record<string, string[]>
    notOption?: Record<string, string[]>
    /** Visible characters: none, one, or several. */
    cast?: 'none' | 'solo' | 'multi'
    viewpoint?: PainterViewpoint
}

export type ModifierRule = { when?: ModifierCondition } & (
    | { add: Record<string, string[]> }
    | { replace: Record<string, string> }
    | { remove: Record<string, '*' | string[]> }
    /** An empty list hides the part; otherwise the part is seen from those directions. */
    | { visibility: Partial<Record<PainterBodyPart | '*', PainterView[]>> }
)

export interface ModifierOption {
    id: string
    tags: Array<[weight: number, tag: string]>
    use?: string
    explicit?: boolean
    bodyPart?: PainterBodyPart
    visibleFrom?: PainterView[]
    rules?: ModifierRule[]
    /** NovelAI character position on its 0.1 to 0.9 grid; the other axis defaults to 0.5. */
    center?: { x?: number; y?: number }
}

export interface ModifierGroup {
    id: string
    scope: 'scene' | 'subject'
    /** 'local' groups are switched on only by rules and never offered to the planner. */
    select: { by: 'ai' | 'local'; max: number }
    /** Position within the rendered tag line. */
    order: number
    description?: string
    bodyPart?: PainterBodyPart
    visibleFrom?: PainterView[]
    viewpoint?: PainterViewpoint
    /** Also offered for object subjects; other subject groups apply to characters only. */
    objects?: boolean
    /** Open vocabulary: the planner writes Danbooru tags instead of option IDs. */
    freeTags?: { max: number; prefix?: string }
    options: ModifierOption[]
}

const FRONT_SIDE: PainterView[] = ['front', 'side']

const opt = (id: string, tags = id.replace(/_/g, ' '), extra: Omit<ModifierOption, 'id' | 'tags'> = {}): ModifierOption =>
    ({ id, tags: tags ? tags.split(', ').map(tag => [1, tag] as [number, string]) : [], ...extra })
const hide = (...parts: PainterBodyPart[]): ModifierRule => ({ visibility: Object.fromEntries(parts.map(part => [part, []])) })

export const PAINTER_MODIFIER_GROUPS: readonly ModifierGroup[] = Object.freeze([
    {
        id: 'camera.view', scope: 'scene', select: { by: 'ai', max: 1 }, order: 20,
        description: 'camera angle; leave empty for an ordinary eye-level front view, the usual choice',
        options: [
            opt('from_side'),
            opt('from_behind', undefined, { rules: [{ add: { 'orientation.facing': ['facing_away'] } }] }),
            opt('from_above', undefined, { use: 'every main subject is low: seated, kneeling or lying; never with a standing main subject' }),
            opt('from_below', undefined, { use: 'looking up at a standing subject' }),
            opt('dutch_angle', undefined, { use: 'tension or unease only' }),
        ],
    },
    {
        id: 'camera.pov', scope: 'scene', select: { by: 'ai', max: 1 }, order: 21, viewpoint: 'first-person',
        description: "only when the viewer's hands or arms visibly act",
        options: [opt('pov_hands')],
    },
    {
        id: 'framing.crop', scope: 'scene', select: { by: 'ai', max: 1 }, order: 22,
        description: 'lowest body part inside the frame for the main subjects; usually cowboy_shot or upper_body',
        options: [
            opt('portrait', undefined, { rules: [hide('bottom', 'legs', 'feet')] }),
            opt('close_up', 'close-up', { rules: [hide('top', 'bottom', 'legs', 'feet')] }),
            opt('upper_body', undefined, { rules: [hide('legs', 'feet')] }),
            opt('cowboy_shot', undefined, { rules: [hide('feet')] }),
            opt('feet_out_of_frame', undefined, { rules: [hide('feet')] }),
            opt('full_body', undefined, { use: 'only when feet or the whole standing or lying figure matter to the moment' }),
        ],
    },
    {
        id: 'framing.head_crop', scope: 'scene', select: { by: 'ai', max: 1 }, order: 23,
        description: 'only when the top edge of the frame cuts the head',
        options: [
            opt('head_out_of_frame', undefined, { rules: [hide('head', 'eyes')] }),
            opt('eyes_out_of_frame', undefined, { rules: [hide('eyes')] }),
        ],
    },
    {
        id: 'scene.environment', scope: 'scene', select: { by: 'ai', max: 1 }, order: 30,
        options: [opt('indoors'), opt('outdoors')],
    },
    {
        id: 'scene.time', scope: 'scene', select: { by: 'ai', max: 1 }, order: 31,
        options: [opt('morning'), opt('day'), opt('sunset'), opt('night')],
    },
    {
        id: 'scene.weather', scope: 'scene', select: { by: 'ai', max: 1 }, order: 32,
        options: [opt('cloudy_sky'), opt('rain'), opt('snow'), opt('fog')],
    },
    {
        id: 'scene.lighting', scope: 'scene', select: { by: 'ai', max: 1 }, order: 33,
        options: [opt('sunlight'), opt('moonlight'), opt('candlelight'), opt('backlighting'), opt('sidelighting'), opt('dim_lighting'), opt('dark')],
    },
    {
        id: 'scene.background', scope: 'scene', select: { by: 'ai', max: 1 }, order: 34,
        options: [opt('blurry_background'), opt('depth_of_field'), opt('simple_background')],
    },
    {
        id: 'scene.location', scope: 'scene', select: { by: 'ai', max: 2 }, order: 35,
        description: 'Danbooru place tags such as classroom, kitchen, bedroom, street',
        freeTags: { max: 2 }, options: [],
    },
    {
        id: 'pose.body', scope: 'subject', select: { by: 'ai', max: 1 }, order: 40,
        options: [
            opt('standing'), opt('sitting'), opt('kneeling'), opt('squatting'), opt('seiza'), opt('wariza'),
            opt('lying'), opt('on_back'), opt('on_side'), opt('on_stomach'), opt('all_fours'),
            opt('leaning_forward'), opt('walking'), opt('running'),
        ],
    },
    {
        id: 'orientation.facing', scope: 'subject', select: { by: 'local', max: 1 }, order: 41,
        options: [
            opt('facing_viewer'),
            opt('facing_another'),
            opt('facing_away', undefined, { rules: [
                { when: { notOption: { 'gaze.direction': ['looking_back'] } }, visibility: { '*': ['back'] } },
                { when: { option: { 'gaze.direction': ['looking_back'] } }, visibility: { '*': ['back'], head: ['side'], eyes: ['side'] } },
            ] }),
        ],
    },
    {
        id: 'pose.arms', scope: 'subject', select: { by: 'ai', max: 2 }, order: 42, bodyPart: 'top',
        options: [
            opt('arms_up'), opt('arm_up'), opt('arms_behind_back'), opt('arms_behind_head'), opt('crossed_arms'),
            opt('hand_on_own_hip'), opt('hands_on_own_hips'), opt('hand_on_own_chest'), opt('hand_on_own_cheek'),
            opt('hand_to_own_mouth'), opt('hands_clasped', 'own hands clasped'), opt('waving'), opt('outstretched_hand'),
            opt('reaching'), opt('pointing'), opt('v'), opt('salute'),
        ],
    },
    {
        id: 'pose.legs', scope: 'subject', select: { by: 'ai', max: 2 }, order: 43, bodyPart: 'legs',
        options: [
            opt('crossed_legs'), opt('knees_up'), opt('knee_up'), opt('leg_up'), opt('standing_on_one_leg'),
            opt('indian_style'), opt('legs_together'), opt('crossed_ankles', undefined, { bodyPart: 'feet' }),
        ],
    },
    {
        id: 'gaze.direction', scope: 'subject', select: { by: 'ai', max: 1 }, order: 44, bodyPart: 'eyes', visibleFrom: FRONT_SIDE,
        options: [
            opt('looking_at_viewer'),
            opt('looking_at_another', undefined, {
                use: 'another visible character',
                rules: [{ when: { viewpoint: 'first-person', cast: 'solo' }, replace: { 'gaze.direction': 'looking_at_viewer' } }],
            }),
            opt('eye_contact', undefined, { use: 'two visible characters look at each other' }),
            opt('looking_away'), opt('looking_to_the_side'), opt('looking_down'), opt('looking_up'),
            opt('looking_afar'), opt('looking_back'),
        ],
    },
    {
        id: 'expression.general', scope: 'subject', select: { by: 'ai', max: 2 }, order: 45, bodyPart: 'head', visibleFrom: FRONT_SIDE,
        options: [
            opt('smile'), opt('light_smile'), opt('grin'), opt('laughing'), opt('smug'), opt('embarrassed'),
            opt('surprised'), opt('angry'), opt('annoyed'), opt('serious'), opt('sad'), opt('worried'),
            opt('scared'), opt('nervous'), opt('confused'), opt('expressionless'), opt('pout'), opt('frown'), opt('sleepy'),
        ],
    },
    {
        id: 'expression.blush', scope: 'subject', select: { by: 'ai', max: 1 }, order: 46, bodyPart: 'head', visibleFrom: FRONT_SIDE,
        options: [opt('blush'), opt('light_blush'), opt('full_face_blush', 'full-face blush')],
    },
    {
        id: 'expression.tears', scope: 'subject', select: { by: 'ai', max: 1 }, order: 47, bodyPart: 'eyes', visibleFrom: FRONT_SIDE,
        options: [opt('tears'), opt('tearing_up'), opt('crying'), opt('crying_with_eyes_open')],
    },
    {
        id: 'expression.eyes', scope: 'subject', select: { by: 'ai', max: 1 }, order: 48, bodyPart: 'eyes', visibleFrom: FRONT_SIDE,
        options: [opt('closed_eyes'), opt('one_eye_closed'), opt('half_closed_eyes', 'half-closed eyes'), opt('wide_eyed', 'wide-eyed')],
    },
    {
        id: 'expression.mouth', scope: 'subject', select: { by: 'ai', max: 1 }, order: 49, bodyPart: 'head', visibleFrom: FRONT_SIDE,
        options: [opt('open_mouth'), opt('closed_mouth'), opt('parted_lips'), opt('clenched_teeth'), opt('tongue_out')],
    },
    {
        id: 'action.held', scope: 'subject', select: { by: 'ai', max: 2 }, order: 60, bodyPart: 'top',
        description: 'objects held in the hands, as Danbooru holding tags such as holding cup',
        freeTags: { max: 2, prefix: 'holding ' }, options: [],
    },
    {
        id: 'frame.position', scope: 'subject', objects: true, select: { by: 'ai', max: 1 }, order: 80,
        description: 'horizontal position of this character or object in the frame; with two or more subjects give every one a position, matching the camera and keeping each interacting pair side by side',
        options: [
            opt('far_left', '', { center: { x: 0.1 } }), opt('left', '', { center: { x: 0.3 } }), opt('center', '', { center: { x: 0.5 } }),
            opt('right', '', { center: { x: 0.7 } }), opt('far_right', '', { center: { x: 0.9 } }),
        ],
    },
    {
        id: 'frame.height', scope: 'subject', objects: true, select: { by: 'ai', max: 1 }, order: 81,
        description: 'vertical position of the body center; leave empty for the middle; low suits a seated or squatting figure next to a standing one',
        options: [opt('high', '', { center: { y: 0.3 } }), opt('low', '', { center: { y: 0.7 } })],
    },
] satisfies ModifierGroup[])

const optionUse = (option: ModifierOption) => option.use ? `${option.id} (${option.use})` : option.id

/** Compact catalog listing for the planner contract; local groups are never offered. */
export function painterModifierCatalogPrompt(viewpoint: PainterViewpoint): string {
    return PAINTER_MODIFIER_GROUPS
        .filter(group => group.select.by === 'ai' && (!group.viewpoint || group.viewpoint === viewpoint))
        .map(group => {
            const head = `${group.id} (${group.scope}, up to ${group.freeTags?.max ?? group.select.max}${group.description ? `; ${group.description}` : ''})`
            return group.freeTags
                ? `${head}: free tags${group.freeTags.prefix ? ` starting with "${group.freeTags.prefix.trim()}"` : ''}`
                : `${head}: ${group.options.map(optionUse).join(', ')}`
        })
        .join('\n')
}
