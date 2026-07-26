export interface AuthenticatedUser {
  sub: string;
  email: string;
  name?: string;
  groups: string[];
  linuxUser: string;
  isSuperAdmin?: boolean;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}
