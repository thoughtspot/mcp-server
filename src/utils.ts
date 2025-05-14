export type Props = {
    accessToken: string;
    instanceUrl: string;
};

export const capitalize = (s: string): string => {
    if (!s) return '';
    return s.charAt(0).toUpperCase() + s.slice(1);
};