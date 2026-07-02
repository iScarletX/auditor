import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

export function truncateMiddle(value: string, max = 80) {
  if (value.length <= max) return value
  const side = Math.floor((max - 3) / 2)
  return `${value.slice(0, side)}...${value.slice(-side)}`
}
