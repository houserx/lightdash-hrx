import { type SpaceShare } from '@lightdash/common';
import { type AccessPrincipal } from '../AccessPanel/AccessPanel';

export const getUserNameOrEmail = (
    userUuid: string | undefined,
    firstName: string | undefined,
    lastName: string | undefined,
    email: string | undefined,
    isInternal: boolean,
) => {
    if (isInternal) {
        return firstName || 'Service account';
    } else if (firstName && lastName) {
        return `${firstName} ${lastName}`;
    } else if (email) {
        return email;
    } else {
        return userUuid;
    }
};

const getInitials = (
    userUuid: string | undefined,
    firstName: string | undefined,
    lastName: string | undefined,
    email: string | undefined,
    isInternal: boolean,
) => {
    if (isInternal) {
        return 'SA';
    } else if (firstName && lastName) {
        return firstName.substr(0, 1) + lastName.substr(0, 1);
    } else if (email) {
        return email.substr(0, 2).toUpperCase();
    } else {
        return userUuid;
    }
};

/** How a space share is named in a row, shared by the manage and audit lists. */
export const toUserPrincipal = (
    share: SpaceShare,
    isSessionUser: boolean,
): AccessPrincipal => ({
    type: 'user',
    userUuid: share.userUuid,
    name: getUserNameOrEmail(
        share.userUuid,
        share.firstName,
        share.lastName,
        share.email,
        share.isInternal,
    ),
    initials: getInitials(
        share.userUuid,
        share.firstName,
        share.lastName,
        share.email,
        share.isInternal,
    ),
    avatarUrl: share.avatarUrl,
    avatarGradient: share.avatarGradient,
    isServiceAccount: share.isInternal,
    isSessionUser,
});
