import gsap from 'gsap'
import { useGSAP } from '@gsap/react'
import { CustomEase } from 'gsap/CustomEase'

gsap.registerPlugin(useGSAP, CustomEase)

// kivz.dev's curves (kivz-v3 src/motion/gsap.ts), so Earmark moves like the site. Pick by job, never one for everything.
CustomEase.create('soft', '0.22, 1, 0.36, 1') // default ease-out, colour fades, page parts
CustomEase.create('spring', 'M0,0 C0.14,0.62 0.25,1.04 0.45,1.035 0.62,1.03 0.78,0.998 1,1') // 3.5 % past: the highlight's glide
CustomEase.create('swift', '0.65, 0, 0.35, 1') // layout moves
CustomEase.create('settle', '0.05, 0.85, 0.3, 1') // arrives at speed and settles: entrances
CustomEase.create('slide', '0.32, 0.1, 0.18, 1') // slid by hand: even speed, stops as if by friction
CustomEase.create('pop', 'M0,0 C0.2,0.9 0.35,1.18 0.55,1.08 0.72,0.99 0.85,1.005 1,1') // a quick snap with a little rebound

/** SwiftUI's `.smooth` (0.5 s critically damped spring), normalised to end at exactly 1. */
const APPLE_K = (2 * Math.PI / 0.5) * 0.55
gsap.registerEase('apple', (p: number) => (1 - (1 + APPLE_K * p) * Math.exp(-APPLE_K * p)) / (1 - (1 + APPLE_K) * Math.exp(-APPLE_K)))

gsap.defaults({ ease: 'soft', duration: 0.6 })

/** true when the visitor asked for less motion — every choreography has a calm fallback */
export const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches

if (import.meta.env.DEV) (window as unknown as { __gsap: typeof gsap }).__gsap = gsap

export { gsap, useGSAP, CustomEase }
