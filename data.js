export const CATS = ["Lieu","Traiteur","Brasseur","Photos","Musique/ambiance","Tenues","Décorations","Alliances","Divers/imprévus","Voyage de noces","Faire-part"];
export const BUDGETS = {Lieu:4500,Traiteur:7000,Brasseur:2000,Photos:3200,"Musique/ambiance":800,Tenues:4000,"Décorations":1600,Alliances:2000,"Divers/imprévus":1600,"Voyage de noces":0,"Faire-part":0};
export const GROUPES = ["Famille Loïc","Amis Loïc","Famille Caro","Amis Caro","Collègues Caro","Amis communs","Témoins Loïc","Témoins Caro"];
export const REGIMES = ["Standard","Végétarien","Végan","Halal","Casher","Autre"];
export const ALLERGENES = ["Gluten","Lactose","Fruits à coque","Arachides","Œufs","Crustacés","Poisson","Soja"];

// Les vraies données (dépenses, revenus, invités) vivent dans Firebase,
// protégées par authentification. Ce fichier ne contient qu'une structure vide
// utilisée le temps que les données chargent depuis Firebase.
export const DEFAULT_DATA = {
  depenses: [],
  revenus: [],
  foyers: [],
  taches: []
};
