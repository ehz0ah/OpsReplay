import { createContext, useContext } from 'react';
export const OwnerContext = createContext('');
export function useOwner() {
  const owner = useContext(OwnerContext);
  if (!owner) throw new Error('The learner context is missing.');
  return owner;
}
