/**
 * Fresh, plausible signup data for every attempt. Nothing here is reused
 * between attempts — a retry must look like a brand-new person to Metered.
 */
import { randomInt, randomPassword, randomToken } from "./util";

const FIRST_NAMES = [
  "Omar", "Yousef", "Karim", "Tariq", "Samir", "Nadia", "Layla", "Mariam",
  "Daniel", "Adrian", "Maya", "Sofia", "Noah", "Elias", "Hana", "Leila",
];

const LAST_NAMES = [
  "Hassan", "Nasser", "Farouk", "Mansour", "Khalil", "Saleh", "Rahman", "Aziz",
  "Bennett", "Carter", "Moreno", "Silva", "Novak", "Weber", "Rossi", "Haddad",
];

const COMPANY_WORDS = [
  "Atlas", "Cedar", "Delta", "Falcon", "Harbor", "Juniper", "Orbit", "Pioneer",
  "Summit", "Vertex", "Willow", "Zephyr",
];

export interface SignupIdentity {
  firstName: string;
  lastName: string;
  company: string;
  email: string;
  password: string;
  appName: string;
}

export function makeSignupIdentity(email: string): SignupIdentity {
  const firstName = FIRST_NAMES[randomInt(FIRST_NAMES.length)]!;
  const lastName = LAST_NAMES[randomInt(LAST_NAMES.length)]!;
  const company = `${COMPANY_WORDS[randomInt(COMPANY_WORDS.length)]!} ${randomToken(2, "ABCDEFGHJKLMNPQRSTUVWXYZ")}`;
  return {
    firstName,
    lastName,
    company,
    email,
    password: randomPassword(18),
    appName: `app${(randomInt(900000) + 100000).toString()}`,
  };
}
