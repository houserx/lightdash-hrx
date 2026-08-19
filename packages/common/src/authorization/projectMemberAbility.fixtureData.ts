import { type ProjectMemberRole } from '../types/projectMemberRole';
import { type AbilityAction, type CaslSubjectNames } from './types';

export type FixtureEntry = {
    role: ProjectMemberRole;
    action: AbilityAction;
    subjectType: CaslSubjectNames;
    resource: Record<string, unknown>;
    expected: boolean;
};

// Must match projectMemberAbility.mock.ts's (now-deleted) PROJECT_VIEWER,
// since captured resource literals below were generated against that
// exact member context.
export const projectUuid = 'project-uuid-1234';
export const userUuid = 'user-uuid-1234';
